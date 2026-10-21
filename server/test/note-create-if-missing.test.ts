// #478: append_note and upsert_note create a missing note with
// createNoteIfMissing. However the race goes, a call that does not create
// the note gets null (it then edits the note), never "already exists".
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteRevisions } from '../src/db/schema.js'
import { createNote, createNoteIfMissing, getLiveNote, type Actor } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

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
})
