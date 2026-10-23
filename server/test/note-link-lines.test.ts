// #558: wikilinks are stored with the body lines they are written on (one
// row per link, a target linked twice is two rows), the file line where a
// body begins turns them into whole-file lines, and rows written without
// lines (before migration 0031, or by older code) are located at boot.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { asc, eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteLinks } from '../src/db/schema.js'
import { bodyStartLine, extractWikilinkLocations, serializeNote, type Frontmatter } from '../src/notes/okf.js'
import { createNote } from '../src/notes/store.js'
import { backfillLinkLines } from '../src/notes/store-tx.js'
import { createActiveUser, loginCookie } from './helpers.js'

describe('extractWikilinkLocations', () => {
  it('lists every link with its body lines; code, inline code and comments keep their lines but give no link', () => {
    const body = [
      'Intro [[a/one]] and [[b/two|Two]].', // 1
      '```ts', // 2
      'const x = [[code/ignored]]', // 3
      '```', // 4
      'Inline `[[inline/ignored]]` then [[a/one#goals]].', // 5
      '<!-- [[comment/ignored]]', // 6
      '-->', // 7
      'Split [[c/', // 8
      'three]] link.', // 9
    ].join('\n')
    expect(extractWikilinkLocations(body)).toEqual([
      { target: 'a/one', startLine: 1, endLine: 1 },
      { target: 'b/two', startLine: 1, endLine: 1 },
      { target: 'a/one', startLine: 5, endLine: 5 },
      { target: 'c/\nthree', startLine: 8, endLine: 9 },
    ])
  })
})

describe('bodyStartLine', () => {
  it('is the file line the body begins on, as serializeNote writes it', () => {
    const cases: Frontmatter[] = [{ type: 'docs' }, { type: 'docs', tags: ['a', 'b'], description: 'one\ntwo\nthree' }]
    for (const frontmatter of cases) {
      const lines = serializeNote({ frontmatter, body: 'BODY FIRST LINE\nsecond' }).split('\n')
      expect(lines[bodyStartLine(frontmatter) - 1]).toBe('BODY FIRST LINE')
    }
  })
})

describe('note_links rows (#558)', () => {
  let app: FastifyInstance
  let vaultId: string

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'link lines' } })).json<{ id: string }>().id
  })

  afterAll(async () => {
    await app.close()
  })

  const rows = (noteId: string) =>
    db
      .select({ target: noteLinks.targetPath, start: noteLinks.startLine, end: noteLinks.endLine })
      .from(noteLinks)
      .where(eq(noteLinks.sourceNoteId, noteId))
      .orderBy(asc(noteLinks.startLine), asc(noteLinks.targetPath))

  it('a save stores one row per link with its body lines, a target linked twice on two lines twice', async () => {
    const note = await createNote(vaultId, { path: 'lines/many', body: 'first [[lines/x]]\n\nthen [[lines/y]] and [[lines/x]] again\n[[lines/x]]\n' })
    expect(await rows(note.id)).toEqual([
      { target: 'lines/x', start: 1, end: 1 },
      { target: 'lines/x', start: 3, end: 3 },
      { target: 'lines/y', start: 3, end: 3 },
      { target: 'lines/x', start: 4, end: 4 },
    ])
  })

  it('the boot backfill locates rows written without lines, and leaves located notes alone', async () => {
    const old = await createNote(vaultId, { path: 'lines/old', body: 'intro\n[[lines/a]]\n\n[[lines/b]]\n' })
    const fresh = await createNote(vaultId, { path: 'lines/fresh', body: '[[lines/a]]\n' })
    // As migration 0031 leaves rows written before it (or older code writes them): line 0.
    await db.execute(sql`DELETE FROM note_links WHERE source_note_id = ${old.id}`)
    await db.execute(sql`INSERT INTO note_links (source_note_id, target_path) VALUES (${old.id}, 'lines/a'), (${old.id}, 'lines/b')`)
    expect(await rows(old.id)).toEqual([
      { target: 'lines/a', start: 0, end: 0 },
      { target: 'lines/b', start: 0, end: 0 },
    ])
    const freshBefore = await rows(fresh.id)

    expect(await backfillLinkLines()).toBeGreaterThanOrEqual(1)
    expect(await rows(old.id)).toEqual([
      { target: 'lines/a', start: 2, end: 2 },
      { target: 'lines/b', start: 4, end: 4 },
    ])
    expect(await rows(fresh.id)).toEqual(freshBefore)
    // Nothing left to locate: a second boot does nothing.
    expect(await backfillLinkLines()).toBe(0)
  })
})
