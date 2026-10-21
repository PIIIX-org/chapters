// #478: append_note and upsert_note create a missing note with
// createNoteIfMissing. However the race goes, a call that does not create
// the note gets null (it then edits the note), never "already exists".
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteRevisions } from '../src/db/schema.js'
import { createNote, createNoteIfMissing, getLiveNote, type Actor } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

/**
 * A one-shot gate on the store's note lock: the first caller of `gate.key`
 * reports it reached the lock (createNoteIfMissing has done its exists-check
 * by then) and waits there until the test opens the gate. That forces the
 * race window open: another writer creates the note in between, every run.
 */
const gate: { key?: string; reached?: () => void; open?: Promise<void> } = {}
vi.mock('../src/notes/key-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/notes/key-lock.js')>()
  return {
    ...actual,
    withKeyLock: async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      if (key === gate.key) {
        gate.key = undefined
        gate.reached?.()
        await gate.open
      }
      return actual.withKeyLock(key, fn)
    },
  }
})

let app: FastifyInstance
let vaultId: string
let user: Actor
const agent: Actor = { type: 'mcp' }

async function revisionsOf(noteId: string) {
  return db.select().from(noteRevisions).where(eq(noteRevisions.noteId, noteId))
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  user = { type: 'user', id: owner.id }
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Create if missing' } })).json<{ id: string }>().id
})

afterAll(async () => app.close())

describe('createNoteIfMissing (#478)', () => {
  it('creates a missing note and answers null for one that exists, leaving it untouched', async () => {
    const made = await createNoteIfMissing(vaultId, { path: 'docs/fresh', body: 'made\n' }, agent)
    expect(made?.body).toBe('made\n')
    const existing = await createNote(vaultId, { path: 'docs/already-there', body: 'kept\n' }, user)
    expect(await createNoteIfMissing(vaultId, { path: 'docs/already-there', body: 'other\n' }, agent)).toBeNull()
    expect((await revisionsOf(existing.id)).map((r) => [r.action, r.body])).toEqual([['create', 'kept\n']])
  })

  it('racing create_note, which does not check first, it answers null when that create wins, never "already exists"', async () => {
    for (let round = 0; round < 10; round++) {
      const path = `docs/raced-${round}`
      const [mine, theirs] = await Promise.allSettled([
        createNoteIfMissing(vaultId, { path, body: 'mine\n' }, agent),
        createNote(vaultId, { path, body: 'theirs\n' }, user),
      ])
      expect(mine.status, mine.status === 'rejected' ? String(mine.reason) : '').toBe('fulfilled')
      if (theirs.status === 'fulfilled' && mine.status === 'fulfilled') expect(mine.value).toBeNull()
      const row = (await getLiveNote(vaultId, path))!
      const creates = await db.select().from(noteRevisions).where(and(eq(noteRevisions.noteId, row.id), eq(noteRevisions.action, 'create')))
      expect(creates).toHaveLength(1)
    }
  })

  it('another writer creating the note between its exists-check and its insert: null, the other note kept, one create', async () => {
    const path = 'docs/forced-race'
    // The server's TypeScript lib predates Promise.withResolvers, so the executor form.
    let reach!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => (reach = resolve))
    gate.open = new Promise<void>((resolve) => (release = resolve))
    Object.assign(gate, { key: `note:${vaultId}/${path}`, reached: reach })
    const mine = createNoteIfMissing(vaultId, { path, body: 'mine\n' }, agent)
    // It found no note and is about to insert: create it from outside, as create_note or restore_note would.
    await reached
    const theirs = await createNote(vaultId, { path, body: 'theirs\n' }, user)
    release()
    expect(await mine).toBeNull()
    expect((await getLiveNote(vaultId, path))?.body).toBe('theirs\n')
    expect((await revisionsOf(theirs.id)).map((r) => [r.action, r.body])).toEqual([['create', 'theirs\n']])
  })
})
