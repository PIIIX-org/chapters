// #501: the compaction job itself. The delta format round-trips any text
// through the SQL that rebuilds it; the retention keeps the revisions a
// merge, a rebase, a restore point or a proposal needs whole; a crash at
// either failpoint leaves every body readable and a rerun ends where an
// uninterrupted run ends; the job is retried after a crash; purging a base
// keeps the revisions built on it; the rollback UPDATE in backup.md stores
// every revision whole again; and an instance backup holds every body whole.
import { randomBytes } from 'node:crypto'
import AdmZip from 'adm-zip'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { vaults } from '../src/db/schema.js'
import { buildInstanceBackup } from '../src/export/archive.js'
import { FailpointError, setFailpointHandler } from '../src/failpoints.js'
import { jobTiming } from '../src/jobs/durable.js'
import { createNote, purgeRevision, revertNote, updateNote, type Actor } from '../src/notes/store.js'
import {
  KEEP_RECENT_REVISIONS,
  compactNoteRevisions,
  encodeDelta,
  flushRevisionCompaction,
  kickRevisionCompaction,
  scheduleRevisionCompaction,
} from '../src/notes/revision-compaction.js'
import { COMPACT_REVISIONS_JOB } from '../src/notes/store-tx.js'
import { createActiveUser } from './helpers.js'

let vaultId: string
let person: Actor
let counter = 0

interface Stored {
  id: string
  action: string
  body: string
  whole: string
  delta: string | null
  baseOrd: number | null
}

/** Bodies of a note that changes one line per revision. */
function bodies(count: number, lineCount = 60): string[] {
  const lines = Array.from({ length: lineCount }, (_, i) => `line ${i} ${randomBytes(12).toString('hex')}\n`)
  const out = [lines.join('')]
  for (let i = 1; i < count; i++) {
    lines[(i * 7) % lineCount] = `line ${i} changed ${randomBytes(12).toString('hex')}\n`
    out.push(lines.join(''))
  }
  return out
}

/**
 * A note created with `texts[0]` and a history of `texts` (one revision each,
 * recorded directly, so no write queues a compaction job). `actions[i]`
 * overrides revision i's action. Returns the note id and revision ids, oldest first.
 */
async function noteWithHistory(texts: string[], actions: Record<number, string> = {}): Promise<{ noteId: string; ids: string[] }> {
  const note = await createNote(vaultId, { path: `docs/compaction-${++counter}`, frontmatter: { type: 'docs' }, body: texts[0]! }, person)
  const [created] = (await db.execute(sql`SELECT id FROM note_revisions WHERE note_id = ${note.id}`)) as unknown as Array<{ id: string }>
  const ids = [created!.id]
  for (const [i, body] of texts.entries()) {
    if (i === 0) continue
    const [row] = (await db.execute(sql`
      INSERT INTO note_revisions (note_id, actor_type, actor_id, action, frontmatter, body)
      VALUES (${note.id}, 'user', ${person.id!}, ${actions[i] ?? 'update'}, '{"type":"docs"}'::jsonb, ${body})
      RETURNING id`)) as unknown as Array<{ id: string }>
    ids.push(row!.id)
  }
  return { noteId: note.id, ids }
}

/** The note's revisions as stored, oldest first: raw body, rebuilt body, delta, and the base's place in the list. */
async function stored(noteId: string): Promise<Stored[]> {
  const rows = (await db.execute(sql`
    SELECT r.id, r.action, r.body AS raw, note_revision_body(r.body, r.body_delta, r.delta_base_id) AS body,
      r.body_delta::text AS delta, b.ord AS base_ord
    FROM note_revisions r LEFT JOIN note_revisions b ON b.id = r.delta_base_id
    WHERE r.note_id = ${noteId} ORDER BY r.ord`)) as unknown as Array<{
    id: string
    action: string
    raw: string
    body: string
    delta: string | null
    base_ord: string | null
  }>
  const ords = (await db.execute(sql`SELECT ord FROM note_revisions WHERE note_id = ${noteId} ORDER BY ord`)) as unknown as Array<{ ord: string }>
  const index = new Map(ords.map((o, i) => [String(o.ord), i]))
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    body: r.body,
    whole: r.raw,
    delta: r.delta,
    baseOrd: r.base_ord === null ? null : index.get(String(r.base_ord))!,
  }))
}

/** What a run decided per revision (delta and base by position), comparable across notes. */
const shape = (rows: Stored[]) => rows.map((r) => [r.delta, r.baseOrd])

beforeAll(async () => {
  const owner = await createActiveUser()
  person = { type: 'user', id: owner.id }
  const [vault] = await db.insert(vaults).values({ name: 'Compaction job', ownerId: owner.id }).returning()
  vaultId = vault!.id
})

afterEach(() => setFailpointHandler(null))

describe('the revision delta (#501)', () => {
  it('rebuilds any text exactly in SQL', async () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['', 'new text\n'],
      ['old text\n', ''],
      ['a\nb\nc', 'a\nB\nc'],
      ['no newline at the end', 'no newline at the end, edited'],
      ['crlf\r\nline two\r\n', 'crlf\r\nline 2\r\nline three\r\n'],
      ['emoji 😀 first\nsecond 👩‍💻\nthird\n', 'emoji 😀 first\nsecond 👩‍💻 edited\nthird\n𝄞 fourth\n'],
      ['combining é and ü\n\n\nblank lines\n', 'combining é and ü\n\nblank lines\nmore\n'],
      ['日本語の行\n中文行\n한국어 줄\n', '日本語の行\n中文的新行\n한국어 줄\n追加 😀\n'],
      ['😀😀😀\n中\né\n', '中\n😀😀😀\né\n😀'],
    ]
    for (const [base, body] of cases) {
      const delta = JSON.stringify(encodeDelta(base, body))
      const [row] = (await db.execute(sql`SELECT note_revision_patch(${base}, ${delta}::jsonb) AS out`)) as unknown as Array<{ out: string }>
      expect(row!.out, JSON.stringify({ base, body, delta })).toBe(body)
    }
  })

  it('rebuilds random multibyte texts exactly in SQL (fuzz)', async () => {
    // A seeded generator, so a failure names a case that replays.
    let seed = 501
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    const pieces = ['a', 'Z', ' ', '\r', 'é', 'ü', '中', '語', '한', '😀', '👩‍💻', '𝄞', '\u0301', '\t']
    const line = () => Array.from({ length: Math.floor(next() * 12) }, () => pieces[Math.floor(next() * pieces.length)]).join('')
    for (let n = 0; n < 200; n++) {
      const baseLines = Array.from({ length: Math.floor(next() * 30) }, line)
      const bodyLines = baseLines.flatMap((l) => {
        const r = next()
        return r < 0.15 ? [] : r < 0.3 ? [line()] : r < 0.4 ? [l, line()] : [l]
      })
      const ends = (lines: string[]) => lines.join('\n') + (next() < 0.5 ? '\n' : '')
      const base = ends(baseLines)
      const body = ends(bodyLines)
      const delta = JSON.stringify(encodeDelta(base, body))
      const [row] = (await db.execute(sql`SELECT note_revision_patch(${base}, ${delta}::jsonb) AS out`)) as unknown as Array<{ out: string }>
      expect(row!.out, `case ${n}: ${JSON.stringify({ base, body, delta })}`).toBe(body)
    }
  })

  it('patches a many-piece delta on a big multibyte base quickly (byte offsets, not character offsets)', async () => {
    // 900 KiB of mixed ASCII and CJK lines, and a revision with 1,200 scattered line edits: about 2,400 pieces.
    const base = Array.from({ length: 20_000 }, (_, i) => `line ${i} 日本語のテキスト ${randomBytes(8).toString('hex')}\n`)
    const edited = [...base]
    for (let k = 0; k < 1_200; k++) edited[(k * 16 + 7) % edited.length] = `edited ${k} 中文 ${randomBytes(6).toString('hex')}\n`
    // No time limit: past one, diffLines falls back to coarser hunks (fewer pieces) on a slow runner.
    const delta = encodeDelta(base.join(''), edited.join(''), Number.POSITIVE_INFINITY)
    expect(delta.length).toBeGreaterThan(2_000)
    const elapsed = await db.transaction(async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE patch_probe (base text, delta jsonb, sum text) ON COMMIT DROP`)
      await tx.execute(sql`
        INSERT INTO patch_probe VALUES (${base.join('')}, ${JSON.stringify(delta)}::jsonb, md5(${edited.join('')}))`)
      const started = performance.now()
      const [row] = (await tx.execute(sql`
        SELECT md5(note_revision_patch(base, delta)) = sum AS same FROM patch_probe`)) as unknown as Array<{ same: boolean }>
      const ms = performance.now() - started
      expect(row!.same).toBe(true)
      return ms
    })
    // Character offsets took about 750 ms here (substr walks the text from its start for every piece); bytes, about 40.
    expect(elapsed).toBeLessThan(250)
  })
})

// Each test writes and compacts a history of 60-90 revisions: seconds on a loaded machine.
describe('compactNoteRevisions (#501)', { timeout: 60_000 }, () => {
  it('stores old revisions as deltas from whole ones, reads them back exactly, and a rerun changes nothing', async () => {
    const texts = bodies(80)
    const { noteId } = await noteWithHistory(texts)
    const { compacted, examined } = await compactNoteRevisions(noteId)
    const rows = await stored(noteId)
    expect(rows.map((r) => r.body)).toEqual(texts)
    expect(compacted).toBe(rows.filter((r) => r.delta !== null).length)
    expect(compacted).toBeGreaterThan(40)
    // Every revision before the newest ones was decided on once.
    expect(examined).toBe(texts.length - KEEP_RECENT_REVISIONS - 1)
    // The newest revisions stay whole; a delta's base is whole and older; a compacted row keeps no body.
    for (const r of rows.slice(-KEEP_RECENT_REVISIONS)) expect(r.delta).toBeNull()
    for (const [i, r] of rows.entries()) {
      if (r.delta === null) continue
      expect(r.whole).toBe('')
      expect(r.baseOrd).toBeLessThan(i)
      expect(rows[r.baseOrd!]!.delta).toBeNull()
    }
    const before = shape(rows)
    expect(await compactNoteRevisions(noteId)).toEqual({ compacted: 0, examined: 0, kept: {} })
    expect(shape(await stored(noteId))).toEqual(before)
  })

  it('decides on a revision that stays whole once, not again at every run, whichever check keeps it whole (#880)', async () => {
    const short = (n: number) => Array.from({ length: n }, () => `${randomBytes(4).toString('hex')}\n`)
    const first = short(300)
    const rewrite = short(300)
    // Three times its base: refused by the size check, without a diff.
    const grown = [...rewrite, ...rewrite, ...rewrite]
    // Two lines in three kept, of 9-character lines: it passes the shared-lines check, but its
    // delta (a copy piece per kept run, a literal per new line) is over half its size.
    const patchy = grown.map((line, i) => (i % 3 === 2 ? `${randomBytes(4).toString('hex')}\n` : line))
    const texts = [first, rewrite, grown, patchy].map((l) => l.join(''))
    // The newest 20 stay whole and are not examined.
    const recent = Array.from({ length: KEEP_RECENT_REVISIONS }, () => patchy.join(''))
    const { noteId } = await noteWithHistory([...texts, ...recent])
    expect(await compactNoteRevisions(noteId)).toEqual({ compacted: 0, examined: 3, kept: { rewritten: 1, grew: 1, delta: 1 } })
    expect(await compactNoteRevisions(noteId)).toEqual({ compacted: 0, examined: 0, kept: {} })
    // A revision is examined when it leaves the newest 20, and only it.
    await db.execute(sql`
      INSERT INTO note_revisions (note_id, actor_type, actor_id, action, frontmatter, body)
      VALUES (${noteId}, 'user', ${person.id!}, 'update', '{"type":"docs"}'::jsonb, ${patchy.join('')})`)
    expect(await compactNoteRevisions(noteId)).toEqual({ compacted: 1, examined: 1, kept: {} })
    expect((await stored(noteId)).map((r) => r.body)).toEqual([...texts, ...recent, patchy.join('')])
  })

  it('leaves the projector first: writes to another note are projected promptly while a heavy history compacts (#880)', async () => {
    // 60 revisions of a 300 KB note rewritten whole each time: every one is read and diffed.
    const heavy = Array.from({ length: 60 }, () => bodies(1, 7_500)[0]!)
    const { noteId } = await noteWithHistory(heavy)
    const busy = await createNote(vaultId, { path: `docs/compaction-busy-${++counter}`, frontmatter: { type: 'docs' }, body: 'start\n' }, person)
    const compacting = compactNoteRevisions(noteId)
    const delays: number[] = []
    for (let i = 0; i < 20; i++) {
      const written = await updateNote(vaultId, busy.path, { body: `write ${i}\n` }, person)
      const acked = performance.now()
      await vi.waitFor(
        async () => {
          const [p] = (await db.execute(sql`
            SELECT applied_seq FROM note_projections WHERE note_id = ${busy.id} AND projection = 'file'`)) as unknown as Array<{ applied_seq: string }>
          expect(Number(p?.applied_seq)).toBeGreaterThanOrEqual(written!.seq)
        },
        { timeout: 10_000, interval: 5 },
      )
      delays.push(performance.now() - acked)
    }
    delays.sort((a, b) => a - b)
    // Each file is written well within a second of its write (the lab's crash-write control allows 3.5 s).
    expect(delays.at(-1), JSON.stringify(delays.map(Math.round))).toBeLessThan(1_000)
    expect((await compacting).examined).toBe(heavy.length - KEEP_RECENT_REVISIONS - 1)
  })

  it('keeps whole the note as it is, restore points, quarantines, proposals and their bases, and the rebase base', async () => {
    const texts = bodies(70)
    const { noteId, ids } = await noteWithHistory(texts, { 10: 'restore_point', 11: 'quarantine', 12: 'proposal' })
    // The proposal at 12 was made from revision 5; the CRDT state last agreed with revision 20 (ADR-003 §5.4).
    await db.execute(sql`UPDATE note_revisions SET source_revision_id = ${ids[5]!} WHERE id = ${ids[12]!}`)
    await db.execute(sql`UPDATE note_revisions SET seq = 20 WHERE id = ${ids[20]!}`)
    await db.execute(sql`INSERT INTO note_crdt (note_id, snapshot, folded_seq) VALUES (${noteId}, '\\x'::bytea, 20)`)
    // The note as it is: revision 30 holds the row's seq.
    await db.execute(sql`UPDATE notes SET seq = 30 WHERE id = ${noteId}`)
    await db.execute(sql`UPDATE note_revisions SET seq = NULL WHERE note_id = ${noteId} AND seq = 1`)
    await db.execute(sql`UPDATE note_revisions SET seq = 30 WHERE id = ${ids[30]!}`)

    await compactNoteRevisions(noteId)
    const rows = await stored(noteId)
    expect(rows.map((r) => r.body)).toEqual(texts)
    for (const kept of [5, 10, 11, 12, 20, 30]) expect(rows[kept]!.delta, `revision ${kept}`).toBeNull()
    expect(rows.filter((r) => r.delta !== null).length).toBeGreaterThan(20)
    // A quarantine (rewritten in place when continued) or a proposal is never a base.
    for (const r of rows) if (r.baseOrd !== null) expect([11, 12]).not.toContain(r.baseOrd)
  })

  for (const point of ['revisions.compact-before-commit', 'revisions.compact-after-commit'] as const) {
    it(`a crash at ${point} leaves every body readable, and a rerun ends as an uninterrupted run`, async () => {
      const texts = bodies(90)
      const twin = await noteWithHistory(texts)
      await compactNoteRevisions(twin.noteId)
      const { noteId } = await noteWithHistory(texts)

      setFailpointHandler((name) => {
        if (name === point) throw new FailpointError(name)
      })
      await expect(compactNoteRevisions(noteId)).rejects.toThrow(FailpointError)
      setFailpointHandler(null)
      const crashed = await stored(noteId)
      expect(crashed.map((r) => r.body)).toEqual(texts)
      const partial = crashed.filter((r) => r.delta !== null).length
      // Before commit the batch rolls back; after it, the first batch stays.
      if (point === 'revisions.compact-before-commit') expect(partial).toBe(0)
      else expect(partial).toBeGreaterThan(0)

      await compactNoteRevisions(noteId)
      const done = await stored(noteId)
      expect(done.map((r) => r.body)).toEqual(texts)
      expect(shape(done)).toEqual(shape(await stored(twin.noteId)))
    })
  }

  it('runs as a durable job that is retried after a crash and completes', async () => {
    const texts = bodies(60)
    const { noteId } = await noteWithHistory(texts)
    const backoff = jobTiming.backoffBaseMs
    jobTiming.backoffBaseMs = 0
    let crashes = 0
    setFailpointHandler((name) => {
      if (name === 'revisions.compact-after-commit' && crashes++ === 0) throw new FailpointError(name)
    })
    try {
      await db.execute(sql`
        INSERT INTO jobs (kind, payload, idempotency_key)
        VALUES (${COMPACT_REVISIONS_JOB}, jsonb_build_object('noteId', ${noteId}::text, 'seq', 1), ${`${COMPACT_REVISIONS_JOB}:${noteId}:1`})`)
      kickRevisionCompaction()
      await flushRevisionCompaction()
    } finally {
      jobTiming.backoffBaseMs = backoff
    }
    const [job] = (await db.execute(sql`
      SELECT attempts, done_at IS NOT NULL AS done, last_error FROM jobs
      WHERE idempotency_key = ${`${COMPACT_REVISIONS_JOB}:${noteId}:1`}`)) as unknown as Array<{ attempts: number; done: boolean; last_error: string | null }>
    expect(job).toMatchObject({ attempts: 2, done: true, last_error: null })
    const rows = await stored(noteId)
    expect(rows.map((r) => r.body)).toEqual(texts)
    expect(rows.filter((r) => r.delta !== null).length).toBeGreaterThan(30)
  })

  it('boot queues the notes whose history is stored whole (written before #501)', async () => {
    const texts = bodies(60)
    const { noteId } = await noteWithHistory(texts)
    scheduleRevisionCompaction()
    await flushRevisionCompaction()
    const rows = await stored(noteId)
    expect(rows.map((r) => r.body)).toEqual(texts)
    expect(rows.filter((r) => r.delta !== null).length).toBeGreaterThan(30)
  })

  it('reverts a note to a compacted revision exactly', async () => {
    const texts = bodies(60)
    const { noteId } = await noteWithHistory(texts)
    await compactNoteRevisions(noteId)
    const rows = await stored(noteId)
    const index = rows.findIndex((r) => r.delta !== null)
    expect(index).toBeGreaterThan(0)
    const [note] = (await db.execute(sql`SELECT path FROM notes WHERE id = ${noteId}`)) as unknown as Array<{ path: string }>
    const reverted = await revertNote(vaultId, note!.path, rows[index]!.id, person)
    expect(reverted?.body).toBe(texts[index])
    const [row] = (await db.execute(sql`SELECT body FROM notes WHERE id = ${noteId}`)) as unknown as Array<{ body: string }>
    expect(row!.body).toBe(texts[index])
  })

  it('purging a base revision stores the revisions built on it whole again', async () => {
    const texts = bodies(60)
    const { noteId, ids } = await noteWithHistory(texts)
    await compactNoteRevisions(noteId)
    const before = await stored(noteId)
    // Revision 0 is the note as it is (its `seq`), which purge_revision refuses: take a later base.
    const baseIndex = before.find((r) => r.baseOrd !== null && r.baseOrd > 0)!.baseOrd!
    const dependents = before.filter((r) => r.baseOrd === baseIndex).map((r) => r.id)
    expect(dependents.length).toBeGreaterThan(0)

    expect(await purgeRevision(vaultId, ids[baseIndex]!)).toBe(true)
    const after = await stored(noteId)
    expect(after.map((r) => r.body)).toEqual(texts.filter((_, i) => i !== baseIndex))
    for (const r of after.filter((row) => dependents.includes(row.id))) {
      expect(r.delta).toBeNull()
      expect(r.whole).toBe(r.body)
    }
  })

  it('the rollback SQL in backup.md stores every revision whole again, and a roll-forward compacts again', async () => {
    const texts = bodies(60)
    const { noteId } = await noteWithHistory(texts)
    const first = await compactNoteRevisions(noteId)
    expect(first.compacted).toBeGreaterThan(0)
    await db.execute(
      sql.raw(
        'UPDATE note_revisions SET body = note_revision_body(body, body_delta, delta_base_id), ' +
          'body_delta = NULL, delta_base_id = NULL, body_bytes = NULL WHERE body_delta IS NOT NULL; ' +
          'DELETE FROM note_revision_compaction',
      ),
    )
    const rows = await stored(noteId)
    expect(rows.map((r) => r.whole)).toEqual(texts)
    expect(rows.every((r) => r.delta === null)).toBe(true)
    expect((await compactNoteRevisions(noteId)).compacted).toBe(first.compacted)
  })

  it('an instance backup holds every revision body whole', async () => {
    const texts = bodies(60)
    const { noteId } = await noteWithHistory(texts)
    await compactNoteRevisions(noteId)
    expect((await stored(noteId)).some((r) => r.delta !== null)).toBe(true)
    const zip = new AdmZip(await buildInstanceBackup())
    const archived = zip
      .getEntry('db/note_revisions.jsonl')!
      .getData()
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((r) => r.noteId === noteId)
      .sort((a, b) => Number(a.ord) - Number(b.ord))
    expect(archived.map((r) => r.body)).toEqual(texts)
    expect(Object.keys(archived[0]!)).not.toContain('bodyDelta')
  })
})
