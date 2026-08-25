import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import type { Server } from '@hocuspocus/server'
import { buildApp } from '../src/app.js'
import { startCollabServer } from '../src/sync/collab-server.js'
import { issueTicket } from '../src/sync/tickets.js'
import { config } from '../src/config.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let collab: Server
let collabPort: number
let owner: Awaited<ReturnType<typeof createActiveUser>>
let reader: Awaited<ReturnType<typeof createActiveUser>>
let ownerCookie: string
let readerCookie: string
let docName: string

const providers: HocuspocusProvider[] = []
const failures = new WeakMap<HocuspocusProvider, boolean>()

/** POSTs the real endpoint; `host` proves the URL is built from the request. */
async function mintTicket(cookie: string, host = 'chapters.test:3000') {
  return app.inject({
    method: 'POST',
    url: '/api/collab/ticket',
    headers: { cookie, host },
  })
}

function connect(token: string, url = `ws://127.0.0.1:${collabPort}`): HocuspocusProvider {
  const provider = new HocuspocusProvider({
    url,
    name: docName,
    token,
    document: new Y.Doc(),
    onAuthenticationFailed: () => {
      failures.set(provider, true)
    },
  })
  providers.push(provider)
  return provider
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeAll(async () => {
  app = await buildApp()
  collab = await startCollabServer(0)
  collabPort = collab.address.port

  owner = await createActiveUser()
  reader = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  readerCookie = await loginCookie(app, reader.email)

  const vaultId = (
    (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie: ownerCookie },
        body: { name: 'Ticket vault' },
      })
    ).json() as { id: string }
  ).id
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/shares`,
    headers: { cookie: ownerCookie },
    body: { granteeType: 'user', granteeId: reader.id, permission: 'read' },
  })
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: ownerCookie },
    body: { type: 'docs', name: 'ticketed', body: 'Ticketed content.' },
  })
  docName = `${vaultId}/docs/ticketed`
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await collab.destroy()
  await app.close()
})

describe('collab ticket', () => {
  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/collab/ticket' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).not.toHaveProperty('token')
  })

  it("returns a same-origin /collab URL, never the relay's private port", async () => {
    const res = await mintTicket(ownerCookie)
    expect(res.statusCode).toBe(200)
    const ticket = res.json() as { token: string; url: string; expiresAt: string }
    // The request's own origin, path appended. `ws://chapters.test:3001` — the
    // relay's real listener — is unreachable behind the documented single-port
    // reverse proxy: not exposed, no certificate, every editor fails to
    // connect. The port is this process's business and never the browser's.
    expect(ticket.url).toBe('ws://chapters.test:3000/collab')
    expect(ticket.url).not.toContain(String(config.collabPort))
    expect(ticket.token).toMatch(/^[0-9a-f]{64}$/)
    const ttl = new Date(ticket.expiresAt).getTime() - Date.now()
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60_000)
  })

  it('hands an https page a wss URL behind a TLS-terminating proxy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/collab/ticket',
      headers: { cookie: ownerCookie, host: 'chapters.test', 'x-forwarded-proto': 'https' },
    })
    const ticket = res.json() as { url: string }
    expect(ticket.url).toBe('wss://chapters.test/collab')
  })

  it('authenticates over the /collab path a reverse proxy forwards', async () => {
    // The proxy (nginx in production, vite in dev) passes the path through
    // untouched, so the relay is asked to serve `/collab`, not `/`. If it
    // refused a non-root path the single-origin URL above would be a dead
    // letter — this is the end of that chain.
    const ticket = (await mintTicket(ownerCookie)).json() as { token: string; url: string }
    const path = new URL(ticket.url).pathname
    expect(path).toBe('/collab')
    const proxied = connect(ticket.token, `ws://127.0.0.1:${collabPort}${path}`)
    await waitFor(() => proxied.document.getText('body').toString().includes('Ticketed content.'))
    expect(failures.get(proxied)).toBeUndefined()
  })

  it('authenticates the websocket once', async () => {
    const { token } = (await mintTicket(ownerCookie)).json() as { token: string }
    const a = connect(token)
    await waitFor(() => a.document.getText('body').toString().includes('Ticketed content.'))
    expect(failures.get(a)).toBeUndefined()
  })

  it('refuses a second use of the same ticket', async () => {
    const { token } = (await mintTicket(ownerCookie)).json() as { token: string }
    const first = connect(token)
    await waitFor(() => first.document.getText('body').toString().length > 0)

    const replay = connect(token)
    await waitFor(() => failures.get(replay) === true)
    expect(replay.document.getText('body').toString()).toBe('')
  })

  it('refuses a ticket past its TTL', async () => {
    const { token } = issueTicket(owner.id, 5)
    await new Promise((r) => setTimeout(r, 40))
    const late = connect(token)
    await waitFor(() => failures.get(late) === true)
    expect(late.document.getText('body').toString()).toBe('')
  })

  it("mints for a reader, and the edit check still refuses them", async () => {
    const res = await mintTicket(readerCookie)
    expect(res.statusCode).toBe(200)
    const { token } = res.json() as { token: string }
    const r = connect(token)
    await waitFor(() => failures.get(r) === true)
    expect(r.document.getText('body').toString()).toBe('')
  })
})
