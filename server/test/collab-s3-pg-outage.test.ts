import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import postgres from 'postgres'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { getLiveNote } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

// ADR-003 S3 (#487, review round 2): with Postgres unreachable, a typed
// change cannot be logged, so the relay closes the socket unacked. The
// reconnect that follows hits the dead store again (the session check, the
// load). That is a pause (`store-busy`), never "access removed", and the
// change lands once Postgres is back. The outage: the test database stops
// accepting connections and every connection to it is terminated, as a
// Postgres restart or failover does to the server's pool.

const DB_NAME = new URL(config.databaseUrl).pathname.slice(1)
const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.ELARA_ADMIN_DATABASE_URL ?? (() => {
  const url = new URL(config.databaseUrl)
  url.pathname = '/postgres'
  return url.toString()
})()
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })

async function outage(down: boolean): Promise<void> {
  await admin.unsafe(`ALTER DATABASE "${DB_NAME}" WITH ALLOW_CONNECTIONS ${down ? 'false' : 'true'}`)
  if (down) await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB_NAME} AND pid <> pg_backend_pid()`
}

let app: FastifyInstance
let collab: CollabRelay
let port: number
let token: string
let cookie: string
let vaultId: string
const providers: HocuspocusProvider[] = []

async function waitFor(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  token = await loginToken(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'S3 outage vault' } })).json().id
})

afterAll(async () => {
  await outage(false)
  await admin.end()
  providers.forEach((p) => p.destroy())
  await collab.destroy()
  await app.close()
})

describe('Postgres unreachable across a reconnect (S3)', () => {
  it('refuses the reconnect with store-busy, not a revocation, and the change lands once Postgres is back', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/notes`, headers: { cookie }, body: { type: 'docs', name: 'outage', body: 'Before.\n' } })
    expect(res.statusCode).toBe(200)
    const noteId: string = res.json().id
    const document = new Y.Doc()
    const reasons: string[] = []
    // What useCollabDoc does on store-busy: a new provider on the same document after a pause.
    const connectTab = () => {
      const provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/collab`,
        name: `${vaultId}/~${noteId}`,
        token,
        document,
        onAuthenticationFailed: ({ reason }) => reasons.push(reason),
        // A store-busy refusal closes the socket too (1013), so it can arrive as the close reason.
        onClose: ({ event }) => {
          if (event.reason) reasons.push(event.reason)
        },
      })
      providers.push(provider)
      return provider
    }
    let provider = connectTab()
    const text = document.getText('body')
    await waitFor(() => provider.isSynced && text.length > 0)

    await outage(true)
    try {
      text.insert(text.length, '@PG-OUTAGE@')
      await waitFor(() => reasons.length > 0, 60_000)
      expect(reasons[0]).toBe('store-busy')
      expect(reasons).not.toContain('permission-denied')
      expect(provider.hasUnsyncedChanges).toBe(true)
    } finally {
      await outage(false)
    }
    provider.destroy()
    provider = connectTab()
    await waitFor(() => provider.isSynced && !provider.hasUnsyncedChanges, 30_000)
    expect(text.toString().split('@PG-OUTAGE@').length - 1).toBe(1)
    await waitFor(async () => ((await getLiveNote(vaultId, 'docs/outage'))?.body ?? '').includes('@PG-OUTAGE@'), 15_000)
  }, 120_000)
})
