// #472: link rows written without a context (before migration 0039, or by
// older code after a rollback) and without lines (before 0031, #558) are
// rewritten from their note's body by durable `note_links` jobs that boot
// queues at catch-up priority; notes whose rows are whole get no job.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { asc, eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteLinks } from '../src/db/schema.js'
import { JOB_PRIORITY } from '../src/jobs/durable.js'
import { LINK_ROWS_JOB, flushLinkCatchUp, scheduleLinkCatchUp } from '../src/notes/link-catch-up.js'
import { createNote } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let vaultId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'link catch-up' } })).json<{ id: string }>().id
})

afterAll(async () => {
  await app.close()
})

const rows = (noteId: string) =>
  db
    .select({ target: noteLinks.targetPath, start: noteLinks.startLine, end: noteLinks.endLine, context: noteLinks.context })
    .from(noteLinks)
    .where(eq(noteLinks.sourceNoteId, noteId))
    .orderBy(asc(noteLinks.startLine), asc(noteLinks.targetPath))

describe('note_links catch-up (#472)', () => {
  it('fills rows without a context or lines from the body, at catch-up priority, and leaves whole notes alone', async () => {
    const old = await createNote(vaultId, { path: 'catch/old', body: 'intro\n[[catch/a]] here\n\nthen [[catch/b]]\n' })
    const lineless = await createNote(vaultId, { path: 'catch/lineless', body: 'x\n\n[[catch/a]]\n' })
    const whole = await createNote(vaultId, { path: 'catch/whole', body: '[[catch/a]]\n' })
    // As 0039 leaves rows written before it: lines, no context.
    await db.execute(sql`UPDATE note_links SET context = NULL WHERE source_note_id = ${old.id}`)
    // As 0031 left rows written before it (and older code after a rollback writes them): no lines either.
    await db.execute(sql`DELETE FROM note_links WHERE source_note_id = ${lineless.id}`)
    await db.execute(sql`INSERT INTO note_links (source_note_id, target_path) VALUES (${lineless.id}, 'catch/a')`)
    const wholeBefore = await rows(whole.id)

    expect(await scheduleLinkCatchUp()).toBeGreaterThanOrEqual(2)
    const queued = (await db.execute(sql`
      SELECT payload->>'noteId' AS note, priority FROM jobs WHERE kind = ${LINK_ROWS_JOB} AND payload->>'noteId' IN (${old.id}, ${lineless.id}, ${whole.id})
      ORDER BY 1`)) as unknown as Array<{ note: string; priority: number }>
    expect(queued.map((q) => q.note).sort()).toEqual([old.id, lineless.id].sort())
    for (const q of queued) expect(q.priority).toBe(JOB_PRIORITY.catchUp)
    await flushLinkCatchUp()

    expect(await rows(old.id)).toEqual([
      { target: 'catch/a', start: 2, end: 2, context: 'intro\n[[catch/a]] here' },
      { target: 'catch/b', start: 4, end: 4, context: 'then [[catch/b]]' },
    ])
    expect(await rows(lineless.id)).toEqual([{ target: 'catch/a', start: 3, end: 3, context: '[[catch/a]]' }])
    expect(await rows(whole.id)).toEqual(wholeBefore)
    // Nothing left to fill: the next boot queues nothing.
    expect(await scheduleLinkCatchUp()).toBe(0)
  })
})
