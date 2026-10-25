// #558: wikilinks are stored with the body lines they are written on (one
// row per link, a target linked twice is two rows), and the file line where
// a body begins turns them into whole-file lines. Rows written without lines
// (before migration 0031, or by older code) are rewritten by the `note_links`
// catch-up jobs (note-link-catch-up.test.ts, #472).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { asc, eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteLinks } from '../src/db/schema.js'
import { extractWikilinkLocations, type Frontmatter } from '../src/notes/okf.js'
import { bodyStartLine, renderNoteFile } from '../src/notes/projector.js'
import { createNote } from '../src/notes/store.js'
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
  it('is the file line the body begins on, as renderNoteFile writes it (in its stored key order)', () => {
    const cases: Array<[Frontmatter, unknown]> = [
      [{ type: 'docs' }, null],
      [{ type: 'docs', tags: ['a', 'b'], description: 'one\ntwo\nthree' }, { description: 'one\ntwo\nthree', type: 'docs', tags: ['a', 'b'] }],
    ]
    for (const [frontmatter, frontmatterSrc] of cases) {
      const lines = renderNoteFile({ frontmatter, frontmatterSrc, body: 'BODY FIRST LINE\nsecond' }).split('\n')
      expect(lines[bodyStartLine({ frontmatter, frontmatterSrc }) - 1]).toBe('BODY FIRST LINE')
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

  it('a body with more links than one insert can bind is saved whole', async () => {
    // 20,000 rows of 4 parameters: past Postgres's 65,535 parameters per statement.
    const body = Array.from({ length: 20_000 }, (_, i) => `[[lines/t${i % 7}]]`).join('\n')
    const note = await createNote(vaultId, { path: 'lines/crowded', body })
    const [row] = (await db.execute(sql`SELECT count(*)::int AS n FROM note_links WHERE source_note_id = ${note.id}`)) as unknown as Array<{ n: number }>
    expect(row?.n).toBe(20_000)
  })
})
