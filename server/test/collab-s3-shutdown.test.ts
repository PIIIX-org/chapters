import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

// S3 (review round 3): an unload fold stores the row, so the relay's
// destroy (and the server's shutdown) must not resolve while one is still
// running. Hocuspocus resolves its own destroy once the last document
// unloaded, which can be before another document's fold finished. One
// document's fold is held for 300 ms here.
const folds = vi.hoisted(() => ({ finished: 0, slow: new Set<string>() }))
vi.mock('../src/notes/store.js', async (importOriginal) => {
  const store = await importOriginal<typeof import('../src/notes/store.js')>()
  return {
    ...store,
    compactCollabState: async (vaultId: string, noteId: string) => {
      if (folds.slow.has(noteId)) await new Promise((r) => setTimeout(r, 300))
      await store.compactCollabState(vaultId, noteId)
      folds.finished++
    },
  }
})

let app: FastifyInstance
let collab: CollabRelay
let port: number
let token: string
let cookie: string
let vaultId: string
const providers: HocuspocusProvider[] = []

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
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
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'S3 shutdown vault' } })).json().id
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await app.close()
})

async function openNote(name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/notes`, headers: { cookie }, body: { type: 'docs', name, body: 'Body.\n' } })
  const noteId: string = res.json().id
  const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/collab`, name: `${vaultId}/~${noteId}`, token, document: new Y.Doc() })
  providers.push(provider)
  await waitFor(() => provider.isSynced && provider.document.getText('body').length > 0)
  return noteId
}

describe('relay shutdown (S3)', () => {
  it('destroy waits for every unload fold, also one that finishes after the last document unloaded', async () => {
    await openNote('fast')
    const slow = await openNote('slow')
    folds.slow.add(slow)
    await collab.destroy()
    expect(folds.finished).toBe(2)
  }, 20_000)
})
