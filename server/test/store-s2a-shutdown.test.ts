import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { getLiveNote, writeNote } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { collabDocName } from '../src/sync/live-docs.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

// ADR-003 §11 R5-1, second half: a graceful shutdown (the relay's destroy,
// which flushes every due store) that starts while a server write holds the
// note's lock and a relay store is due completes; nothing deadlocks and the
// row keeps both the write and the typing. Own file: the test destroys the relay.
// A regression guard for the R5-1 case the ADR lists (§11): it exercises
// #828's write path and `collab.destroy()`, and passes on `dev` as well; the
// bounded projector drain index.ts runs after `destroy()` is not under test here.

let app: FastifyInstance
let collab: CollabRelay
let port: number
let token: string
let cookie: string
let vaultId: string
let provider: HocuspocusProvider | null = null

async function waitFor(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
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
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'S2a shutdown vault' } })).json().id
})

afterAll(async () => {
  provider?.destroy()
  await app.close()
})

describe('graceful shutdown during a write to an open note (§11 R5-1)', () => {
  it('completes: the write finishes, the due store runs after it, and the row keeps both', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'docs', name: 'shutdown', body: 'Start.' },
    })
    expect(created.statusCode).toBe(200)
    const path = 'docs/shutdown'
    provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/collab`, name: collabDocName(vaultId, (created.json() as { id: string }).id), token, document: new Y.Doc() })
    const text = provider.document.getText('body')
    await waitFor(() => provider!.isSynced && text.length > 0)

    // Promise.withResolvers needs lib es2024; the server targets an older lib.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let computing!: () => void
    const inCompute = new Promise<void>((r) => (computing = r))
    const write = writeNote(
      vaultId,
      path,
      async (current) => {
        computing()
        await gate
        return { frontmatter: { ...current.frontmatter, type: 'docs' }, body: `${current.body}\nAgent line.` }
      },
      { type: 'mcp', id: randomUUID() },
    )
    await inCompute
    text.insert(0, 'Typed. ')
    await waitFor(() => !provider!.hasUnsyncedChanges)
    // SIGTERM's first step: flush every due store. It waits for the note lock the write holds.
    let shutDown = false
    const shutdown = collab.destroy().then(() => (shutDown = true))
    // The flush must still be waiting while the write holds the lock: let the store become due first.
    await new Promise((r) => setTimeout(r, 300))
    expect(shutDown).toBe(false)
    release()
    expect((await write)?.body).toContain('Agent line.')
    await shutdown
    const body = (await getLiveNote(vaultId, path))?.body ?? ''
    expect(body).toContain('Agent line.')
    expect(body.match(/Typed\. /g)).toHaveLength(1)
  })
})
