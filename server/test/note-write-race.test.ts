import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { createNote, getRevision, listRevisionMeta, readNote, renameNote, updateNote } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { loadCrdtState } from '../src/sync/crdt-store.js'
import { writeThroughCollab } from '../src/sync/crdt-write.js'
import { createActiveUser, loginCookie } from './helpers.js'

// Every rename waits a beat before it happens. An atomic write's temp file
// then sits on disk long enough for a concurrent write of the same note to
// reach it, so the race is hit on every run rather than by chance. The delay
// is real time: the writes run against real Postgres and disk, which fake
// timers cannot drive.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      return actual.rename(...args)
    },
  }
})

let app: FastifyInstance
let collab: CollabRelay
let cookie: string
let vaultId: string

const WRITES = 10
const bodies = (label: string) => Array.from({ length: WRITES }, (_, i) => `${label} write ${i} of ${WRITES}.`)

/** Revision bodies oldest first, with back-to-back repeats collapsed. */
async function revisionBodies(path: string): Promise<string[]> {
  const updates = (await listRevisionMeta(vaultId, path, 200, 0))!.filter((r) => r.action === 'update').reverse()
  const revisions = await Promise.all(updates.map((r) => getRevision(vaultId, r.id)))
  return revisions.map((r) => r!.body).filter((body, i, all) => body !== all[i - 1])
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Race vault' } })
  ).json().id
  for (const name of ['store-raced', 'collab-raced']) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'docs', name, body: 'Before the burst.' },
    })
    expect(res.statusCode).toBe(200)
  }
})

afterAll(async () => {
  await collab.destroy()
  await app.close()
})

describe('concurrent writes to one note', () => {
  it('store updates all succeed, apply in call order, and leave file and row agreeing', async () => {
    const path = 'docs/store-raced'
    const writes = bodies('store')
    const results = await Promise.allSettled(writes.map((body) => updateNote(vaultId, path, { body })))

    expect(results.filter((r) => r.status === 'rejected')).toEqual([])
    const note = (await readNote(vaultId, path))!
    expect(note.body).toBe(writes.at(-1))
    expect(note.row.body).toBe(writes.at(-1))
    expect(await revisionBodies(path)).toEqual(writes)
    const leftovers = (await readdir(join(config.dataDir, 'vaults', vaultId, 'docs'))).filter((f) =>
      f.endsWith('.tmp'),
    )
    expect(leftovers).toEqual([])
  }, 15_000)

  it('writes through the live collab engine all succeed and leave file, row and CRDT state agreeing', async () => {
    const path = 'docs/collab-raced'
    const writes = bodies('collab')
    const results = await Promise.allSettled(
      // A real connection id (a uuid): the agent's writes are recorded next to the relay's (#438).
      writes.map((body) => writeThroughCollab(vaultId, path, { body }, { type: 'mcp', id: randomUUID() })),
    )

    expect(results.filter((r) => r.status === 'rejected')).toEqual([])
    const note = (await readNote(vaultId, path))!
    expect(note.body).toBe(writes.at(-1))
    expect(note.row.body).toBe(writes.at(-1))
    expect(await revisionBodies(path)).toEqual(writes)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, (await loadCrdtState(vaultId, path))!)
    expect(doc.getText('body').toString()).toBe(writes.at(-1))
  }, 15_000)
})

describe('renames through the live collab engine (#803)', () => {
  it('a note linking two notes renamed at the same time keeps both rewritten links in file, row and CRDT state', async () => {
    await createNote(vaultId, { path: 'docs/relay-x', body: 'X.' })
    await createNote(vaultId, { path: 'docs/relay-y', body: 'Y.' })
    await createNote(vaultId, { path: 'docs/relay-hub', body: 'Links to [[docs/relay-x]] and [[docs/relay-y]].' })

    await Promise.all([
      renameNote(vaultId, 'docs/relay-x', 'relay-x2', writeThroughCollab),
      renameNote(vaultId, 'docs/relay-y', 'relay-y2', writeThroughCollab),
    ])

    const body = 'Links to [[docs/relay-x2]] and [[docs/relay-y2]].'
    const note = (await readNote(vaultId, 'docs/relay-hub'))!
    expect(note.body).toBe(body)
    expect(note.row.body).toBe(body)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, (await loadCrdtState(vaultId, 'docs/relay-hub'))!)
    expect(doc.getText('body').toString()).toBe(body)
  }, 15_000)
})
