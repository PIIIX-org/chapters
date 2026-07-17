import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import type { Server } from '@hocuspocus/server'
import { buildApp } from '../src/app.js'
import { startCollabServer } from '../src/sync/collab-server.js'
import { config } from '../src/config.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

let app: FastifyInstance
let collab: Server
let port: number
let collabPort: number
let ownerToken: string
let ownerCookie: string
let editor: Awaited<ReturnType<typeof createActiveUser>>
let editorToken: string
let readerCookie: string
let readerToken: string
let vaultId: string
let docName: string

const providers: HocuspocusProvider[] = []

function connect(token: string, name = docName): HocuspocusProvider {
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${collabPort}`,
    name,
    token,
    document: new Y.Doc(),
  })
  providers.push(provider)
  return provider
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  collab = await startCollabServer(0)
  collabPort = collab.address.port

  const owner = await createActiveUser()
  editor = await createActiveUser()
  const reader = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  ownerToken = await loginToken(app, owner.email)
  editorToken = await loginToken(app, editor.email)
  readerCookie = await loginCookie(app, reader.email)
  readerToken = await loginToken(app, reader.email)

  vaultId = (
    (await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie: ownerCookie },
      body: { name: 'Collab vault' },
    })).json() as { id: string }
  ).id
  for (const [granteeId, permission] of [
    [editor.id, 'edit'],
    [reader.id, 'read'],
  ] as const) {
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/shares`,
      headers: { cookie: ownerCookie },
      body: { granteeType: 'user', granteeId, permission },
    })
  }
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: ownerCookie },
    body: { type: 'docs', name: 'shared', body: 'Initial content.' },
  })
  docName = `${vaultId}/docs/shared`
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await collab.destroy()
  await app.close()
})

describe('real-time collaboration', () => {
  it('two editors converge on the same note', async () => {
    const a = connect(ownerToken)
    const b = connect(editorToken)
    await waitFor(() => a.document.getText('body').toString().includes('Initial content.'))
    await waitFor(() => b.document.getText('body').toString().includes('Initial content.'))

    a.document.getText('body').insert(0, 'From A: ')
    await waitFor(() => b.document.getText('body').toString().startsWith('From A: '))

    b.document.getText('body').insert(b.document.getText('body').length, ' And B.')
    await waitFor(() => a.document.getText('body').toString().endsWith(' And B.'))
  })

  it('debounced store persists collab edits to the OKF file via shared validation', async () => {
    const file = join(config.dataDir, 'vaults', vaultId, 'docs', 'shared.md')
    await waitFor(() => true)
    const a = connect(ownerToken)
    await waitFor(() => a.document.getText('body').toString().length > 0)
    a.document.getText('body').insert(0, 'PERSIST-MARKER ')
    a.document.getMap('frontmatter').set('tags', ['collab'])
    let raw = ''
    await waitFor(() => {
      void readFile(file, 'utf8').then((c) => (raw = c)).catch(() => {})
      return raw.includes('PERSIST-MARKER') && raw.includes('collab')
    }, 8000)
    expect(raw).toContain('type: docs')
  })

  it('read-only users cannot join the CRDT socket', async () => {
    let failed = false
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docName,
      token: readerToken,
      document: new Y.Doc(),
      onAuthenticationFailed: () => {
        failed = true
      },
    })
    providers.push(provider)
    await waitFor(() => failed)
    expect(failed).toBe(true)
  })

  it('read-only users get a live SSE view without identity data', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/vaults/${vaultId}/live/docs/shared`, {
      headers: { cookie: readerCookie },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    const initial = decoder.decode(first.value)
    expect(initial).toContain('"body"')
    expect(initial).not.toContain('cursor')

    const a = connect(ownerToken)
    await waitFor(() => a.document.getText('body').toString().length > 0)
    a.document.getText('body').insert(0, 'LIVE-UPDATE ')
    let streamed = ''
    await waitFor(() => {
      void reader.read().then((chunk) => {
        if (chunk.value) streamed += decoder.decode(chunk.value)
      })
      return streamed.includes('LIVE-UPDATE')
    }, 8000)
    await reader.cancel()
  })

  it('revoking an editor mid-session kicks their connection immediately', async () => {
    let closed = false
    const b = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docName,
      token: editorToken,
      document: new Y.Doc(),
      onClose: () => {
        closed = true
      },
    })
    providers.push(b)
    await waitFor(() => b.document.getText('body').toString().length > 0)

    const shares = (
      await app.inject({
        method: 'GET',
        url: `/api/vaults/${vaultId}/shares`,
        headers: { cookie: ownerCookie },
      })
    ).json() as Array<{ id: string; granteeId: string }>
    const editorShare = shares.find((s) => s.granteeId === editor.id)!
    await app.inject({
      method: 'DELETE',
      url: `/api/vaults/${vaultId}/shares/${editorShare.id}`,
      headers: { cookie: ownerCookie },
    })

    await waitFor(() => closed, 8000)
    expect(closed).toBe(true)
  })
})
