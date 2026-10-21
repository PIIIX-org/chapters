// #825, #811: a note's revisions list in the order they were recorded,
// whatever the database clock did. `created_at` comes from the clock, which
// can step back (the local test database did, by up to 400 ms) or give two
// revisions the same instant; the history, its pages and the "latest
// revision" a write is compared with must not follow it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { noteRevisions, vaults } from '../src/db/schema.js'
import {
  createNote,
  listRevisionMeta,
  listRevisionPage,
  recordProposal,
  updateNote,
  type Actor,
  type RevisionPosition,
} from '../src/notes/store.js'
import { createActiveUser } from './helpers.js'

let vaultId: string
let person: Actor

beforeAll(async () => {
  const owner = await createActiveUser()
  person = { type: 'user', id: owner.id }
  vaultId = (await db.insert(vaults).values({ name: 'revision order', ownerId: owner.id }).returning())[0]!.id
})

afterAll(async () => {
  await db.delete(vaults).where(eq(vaults.id, vaultId))
})

/** A note with one revision per body, written in this order by `person`; returns the revision ids in that order. */
async function written(path: string, bodies: string[]): Promise<{ noteId: string; ids: string[] }> {
  const ids: string[] = []
  // The id each write added: the one revision of the note not seen before (bodies may repeat).
  const added = async (noteId: string) => {
    const rows = await db.select({ id: noteRevisions.id }).from(noteRevisions).where(eq(noteRevisions.noteId, noteId))
    ids.push(rows.find((r) => !ids.includes(r.id))!.id)
  }
  const note = await createNote(vaultId, { path, body: bodies[0] }, person)
  await added(note.id)
  for (const body of bodies.slice(1)) {
    await updateNote(vaultId, path, { body }, person)
    await added(note.id)
  }
  return { noteId: note.id, ids }
}

/** Dates the revisions as a stepping clock would: `at[i]` seconds from now for `ids[i]`. */
async function dated(ids: string[], at: number[]): Promise<void> {
  for (const [i, id] of ids.entries()) {
    await db
      .update(noteRevisions)
      .set({ createdAt: sql`date_trunc('second', now()) + make_interval(secs => ${at[i]!})` })
      .where(eq(noteRevisions.id, id))
  }
}

async function pagedIds(path: string, limit: number): Promise<string[]> {
  const ids: string[] = []
  let before: RevisionPosition | undefined
  for (;;) {
    const page = (await listRevisionPage(vaultId, path, limit, before))!
    ids.push(...page.revisions.map((r) => r.id))
    if (!page.next) return ids
    before = page.next
  }
}

describe('revision order does not follow the database clock (#825, #811)', () => {
  it('revisions recorded in the same instant list newest first, in the order they were recorded', async () => {
    const path = 'docs/order-same-instant'
    const { ids } = await written(path, ['one', 'two', 'three', 'four', 'five'])
    await dated(ids, [0, 0, 0, 0, 0])
    const newestFirst = [...ids].reverse()
    expect((await listRevisionMeta(vaultId, path, 20, 0))!.map((r) => r.id)).toEqual(newestFirst)
    for (const limit of [1, 2, 20]) expect(await pagedIds(path, limit), `limit ${limit}`).toEqual(newestFirst)
    // Offset pages split them exactly once.
    const offsetPages = [0, 2, 4].map((offset) => listRevisionMeta(vaultId, path, 2, offset))
    expect((await Promise.all(offsetPages)).flatMap((page) => page!.map((r) => r.id))).toEqual(newestFirst)
  })

  it('a revision recorded after the clock stepped back still lists after the ones before it', async () => {
    const path = 'docs/order-clock-back'
    const { ids } = await written(path, ['first', 'second', 'third'])
    // `second` and `third` were recorded after the clock stepped back by more than a second.
    await dated(ids, [0, -2, -1])
    const newestFirst = [...ids].reverse()
    expect((await listRevisionMeta(vaultId, path, 20, 0))!.map((r) => r.id)).toEqual(newestFirst)
    expect(await pagedIds(path, 1)).toEqual(newestFirst)
  })

  it('a write is compared with the revision recorded last, not the one with the latest clock time', async () => {
    const path = 'docs/order-dedupe'
    const { noteId, ids } = await written(path, ['kept', 'latest'])
    await dated(ids, [0, -2])
    // The note holds `latest`: writing `kept` again changes it and is recorded; its repeat is not.
    await updateNote(vaultId, path, { body: 'kept' }, person)
    await updateNote(vaultId, path, { body: 'kept' }, person)
    const rows = await db.select({ body: noteRevisions.body }).from(noteRevisions).where(eq(noteRevisions.noteId, noteId))
    expect(rows.map((r) => r.body).sort()).toEqual(['kept', 'kept', 'latest'])
    const history = (await listRevisionMeta(vaultId, path, 20, 0))!
    expect(history.slice(1).map((r) => r.id)).toEqual([ids[1], ids[0]])
  })

  it('a resubmitted proposal is compared with the proposal recorded last, not the one with the latest clock time (#475)', async () => {
    const path = 'docs/order-proposal'
    const { noteId, ids } = await written(path, ['base'])
    const frontmatter = { type: 'docs' }
    const first = await recordProposal(noteId, { frontmatter, body: 'proposal one' }, person, ids[0]!)
    const second = await recordProposal(noteId, { frontmatter, body: 'proposal two' }, person, ids[0]!)
    // `second` was recorded after the clock stepped back past `first`.
    await dated([first, second], [0, -2])
    // A retry of the latest proposal returns it instead of adding another.
    expect(await recordProposal(noteId, { frontmatter, body: 'proposal two' }, person, ids[0]!)).toBe(second)
    const proposals = await db
      .select({ id: noteRevisions.id })
      .from(noteRevisions)
      .where(and(eq(noteRevisions.noteId, noteId), eq(noteRevisions.action, 'proposal')))
    expect(proposals.map((r) => r.id).sort()).toEqual([first, second].sort())
  })
})
