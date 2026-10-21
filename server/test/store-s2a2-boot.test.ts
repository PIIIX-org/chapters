import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { createNote, renameNote } from '../src/notes/store.js'
import { flushProjections, renderNoteFile, sweepOrphanFiles, verifyAllProjections } from '../src/notes/projector.js'
import { bootStore } from '../src/notes/store-reconcile.js'
import { setStoreMigrationPending } from '../src/notes/store-tx.js'
import { MaintenanceInProgressError, holdInstanceLock } from '../src/notes/maintenance-lock.js'
import { BackfillPendingError, exportLegacyFiles } from '../src/notes/store-export.js'
import { createActiveUser, loginCookie } from './helpers.js'

/** The `backfill` marker rows of the vault's notes: never a projection, never reset or rendered. */
async function backfillMarkers(vault: string): Promise<string> {
  const rows = (await db.execute(sql`
    SELECT p.note_id, p.target_seq, p.applied_seq, p.index_version FROM note_projections p JOIN notes n ON n.id = p.note_id
    WHERE n.vault_id = ${vault} AND p.projection = 'backfill' ORDER BY p.note_id`)) as unknown as unknown[]
  return JSON.stringify(rows)
}

// ADR-003 S2a-2: boot step 7 (verify every file projection after an unclean
// or unknown shutdown), boot step 9 (orphan sweep to .orphans/) and the
// stopped-server files-only export for a code-only rollback (§9).

let app: FastifyInstance
let vaultId: string
const other = postgres(config.databaseUrl, { max: 1, onnotice: () => {} })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'S2a-2 boot vault' } })).json().id
})

afterEach(async () => {
  await other`SELECT pg_advisory_unlock_all()`
  await flushProjections()
})

afterAll(async () => {
  await other.end()
  await app.close()
})

const file = (...parts: string[]) => join(config.dataDir, 'vaults', vaultId, ...parts)
const exists = (path: string) => stat(path).then(() => true, () => false)
const agent = () => ({ type: 'mcp' as const, id: randomUUID() })

async function rendered(noteId: string): Promise<string> {
  const [row] = (await db.execute(sql`SELECT frontmatter, frontmatter_src, body FROM notes WHERE id = ${noteId}`)) as unknown as Array<{
    frontmatter: unknown
    frontmatter_src: unknown
    body: string
  }>
  return renderNoteFile({ frontmatter: row!.frontmatter, frontmatterSrc: row!.frontmatter_src, body: row!.body })
}

async function conflictCopiesOf(name: string): Promise<string[]> {
  const entries = await readdir(file('.conflicts', 'docs')).catch(() => [] as string[])
  return entries.filter((entry) => entry.startsWith(`${name}.`))
}

describe('boot step 7: verify after an unclean shutdown (§7)', () => {
  it('after a graceful shutdown a truncated file is left alone; after an unclean one it is conflict-copied and rewritten', async () => {
    const torn = await createNote(vaultId, { type: 'docs', name: 'torn', body: 'whole body' })
    await createNote(vaultId, { type: 'docs', name: 'intact', body: 'fine' })
    await flushProjections()
    await writeFile(file('docs/torn.md'), '')
    const before = await readFile(file('docs/intact.md'))
    expect((await bootStore({ lastShutdown: 'graceful' })).verified).toBe(0)
    expect(await readFile(file('docs/torn.md'), 'utf8')).toBe('')
    const markers = await backfillMarkers(vaultId)
    expect(markers).not.toBe('[]')
    const boot = await bootStore({ lastShutdown: 'unclean' })
    // The check covers file and dir_index projections only, never the backfill marker.
    expect(await backfillMarkers(vaultId)).toBe(markers)
    expect(boot.verified).toBeGreaterThanOrEqual(2)
    expect(await readFile(file('docs/torn.md'), 'utf8')).toBe(await rendered(torn.id))
    expect(await conflictCopiesOf('torn')).toHaveLength(1)
    expect((await readFile(file('docs/intact.md'))).equals(before)).toBe(true)
    expect(await conflictCopiesOf('intact')).toHaveLength(0)
  })

  it('runs when the backfill still has failures too (the notes it did process are written meanwhile)', async () => {
    const done = await createNote(vaultId, { type: 'docs', name: 'bf-done', body: 'processed' })
    await flushProjections()
    await writeFile(file('docs/bf-done.md'), '')
    const [state] = (await db.execute(sql`SELECT store_migrated_at FROM instance_state WHERE id = 'singleton'`)) as unknown as Array<{
      store_migrated_at: string | null
    }>
    // A note the backfill cannot read: its file path is a directory (EISDIR), so the backfill fails for it.
    const failing = randomUUID()
    await db.execute(sql`
      INSERT INTO notes (id, vault_id, type, name, path, frontmatter, body)
      VALUES (${failing}, ${vaultId}, 'docs', 'bf-fail', 'docs/bf-fail', '{"type":"docs"}'::jsonb, 'row')`)
    await mkdir(file('docs/bf-fail.md'), { recursive: true })
    await db.execute(sql`UPDATE instance_state SET store_migrated_at = NULL WHERE id = 'singleton'`)
    try {
      const boot = await bootStore({ lastShutdown: 'unclean' })
      expect(boot.migrated).toBe(false)
      expect(boot.verified).toBeGreaterThan(0)
      await flushProjections()
      expect(await readFile(file('docs/bf-done.md'), 'utf8')).toBe(await rendered(done.id))
    } finally {
      setStoreMigrationPending(false)
      await rm(file('docs/bf-fail.md'), { recursive: true, force: true })
      await db.execute(sql`DELETE FROM notes WHERE id = ${failing}`)
      await db.execute(sql`UPDATE instance_state SET store_migrated_at = ${state?.store_migrated_at ?? new Date().toISOString()} WHERE id = 'singleton'`)
    }
  })

  it('keeps an adopted hand-formatted file byte for byte through every later verify (store-migration mid-batch rerun)', async () => {
    const note = await createNote(vaultId, { type: 'docs', name: 'hand-format', body: 'same content\n', frontmatter: { type: 'docs', title: 'Formatted' } })
    await flushProjections()
    // Same content as the row, other YAML formatting: the first verify adopts it (bytes kept, hash recorded).
    const timestamp = (note.frontmatter as Record<string, unknown>).timestamp
    const hand = `---\ntitle:   'Formatted'\ntimestamp: ${JSON.stringify(timestamp)}\ntype:    docs\n---\nsame content\n`
    await writeFile(file('docs/hand-format.md'), hand)
    for (let round = 0; round < 3; round++) {
      await verifyAllProjections()
      await flushProjections()
      expect(await readFile(file('docs/hand-format.md'), 'utf8'), `round ${round}`).toBe(hand)
    }
    expect(await conflictCopiesOf('hand-format')).toHaveLength(0)
  })
})

describe('boot clears the claims a killed process left (§7)', () => {
  it('a store job leased by the process before (a rename refactor holds 10 minutes) runs at the next boot', async () => {
    await createNote(vaultId, { type: 'docs', name: 'leased-dir', body: 'x' })
    await flushProjections()
    await rm(file('docs/index.md'), { force: true })
    const [job] = (await db.execute(sql`
      INSERT INTO jobs (kind, payload, lease_until, attempts)
      VALUES ('store_dir_index', ${JSON.stringify({ vaultId, dirs: ['docs'] })}::jsonb, now() + interval '10 minutes', 1)
      RETURNING id`)) as unknown as Array<{ id: string }>
    await bootStore({ lastShutdown: 'unclean' })
    const [row] = (await db.execute(sql`SELECT done_at FROM jobs WHERE id = ${job!.id}`)) as unknown as Array<{ done_at: string | null }>
    expect(row?.done_at).not.toBeNull()
    expect(await readFile(file('docs/index.md'), 'utf8')).toContain('leased-dir')
  })
})

describe('boot step 9: orphan sweep (§7)', () => {
  it('moves only *.md files without an owner to .orphans/, outside assets/ and dot-directories', async () => {
    await createNote(vaultId, { type: 'docs', name: 'owned', body: 'mine' })
    await flushProjections()
    // Owned by the live note even without a projected_files row (e.g. written by old code).
    await db.execute(sql`DELETE FROM projected_files WHERE vault_id = ${vaultId} AND path = 'docs/owned.md'`)
    await mkdir(file('stray'), { recursive: true })
    await mkdir(file('assets'), { recursive: true })
    await mkdir(file('.conflicts'), { recursive: true })
    await writeFile(file('stray.md'), 'no owner\n')
    await writeFile(file('stray/deep.md'), 'no owner either\n')
    await writeFile(file('stray/notes.txt'), 'not markdown\n')
    await writeFile(file('assets/readme.md'), 'an attachment\n')
    await writeFile(file('.conflicts/kept.md'), 'a conflict copy\n')
    const moved = (await sweepOrphanFiles()).filter((o) => o.vaultId === vaultId)
    expect(moved.map((o) => o.path).sort()).toEqual(['stray.md', 'stray/deep.md'])
    expect(await readFile(file('.orphans/stray.md'), 'utf8')).toBe('no owner\n')
    expect(await readFile(file('.orphans/stray/deep.md'), 'utf8')).toBe('no owner either\n')
    expect(await exists(file('stray.md'))).toBe(false)
    for (const kept of ['docs/owned.md', 'docs/index.md', 'stray/notes.txt', 'assets/readme.md', '.conflicts/kept.md']) {
      expect(await exists(file(kept)), kept).toBe(true)
    }
    // A second sweep finds nothing new and never re-sweeps .orphans/.
    expect((await sweepOrphanFiles()).filter((o) => o.vaultId === vaultId)).toEqual([])
    await rm(file('stray'), { recursive: true, force: true })
  })
})

describe('store-export-legacy (§9)', () => {
  it('is refused while the S2a backfill has not finished, and leaves the backfill markers alone', async () => {
    const [state] = (await db.execute(sql`SELECT store_migrated_at FROM instance_state WHERE id = 'singleton'`)) as unknown as Array<{
      store_migrated_at: string | null
    }>
    await db.execute(sql`UPDATE instance_state SET store_migrated_at = NULL WHERE id = 'singleton'`)
    try {
      await expect(exportLegacyFiles()).rejects.toBeInstanceOf(BackfillPendingError)
    } finally {
      await db.execute(sql`UPDATE instance_state SET store_migrated_at = ${state?.store_migrated_at ?? new Date().toISOString()} WHERE id = 'singleton'`)
    }
    await createNote(vaultId, { type: 'docs', name: 'export-marker', body: 'x' })
    const markers = await backfillMarkers(vaultId)
    const report = await exportLegacyFiles()
    expect(report.ok).toBe(true)
    expect(report.pending.every((p) => p.projection !== 'backfill')).toBe(true)
    expect(await backfillMarkers(vaultId)).toBe(markers)
  })

  it('is refused while a server or writing CLI holds the shared lock', async () => {
    const server = await holdInstanceLock('shared')
    try {
      await expect(exportLegacyFiles()).rejects.toBeInstanceOf(MaintenanceInProgressError)
    } finally {
      await server.release()
    }
  })

  it('renders every pending file, index.md and rename refactor from the rows, then reports ok', async () => {
    const note = await createNote(vaultId, { type: 'docs', name: 'export-me', body: 'from the row' })
    await createNote(vaultId, { type: 'docs', name: 'export-ref', body: 'see [[docs/export-me]]' })
    await renameNote(vaultId, 'docs/export-me', 'export-moved', agent())
    // Rows changed around the store (manual SQL) and files left behind.
    await db.execute(sql`UPDATE notes SET body = 'changed by SQL' WHERE id = ${note.id}`)
    await rm(file('docs/export-moved.md'), { force: true })
    const report = await exportLegacyFiles()
    expect(report.ok).toBe(true)
    expect(report.pending).toEqual([])
    expect(report.pendingJobs).toEqual([])
    expect(await readFile(file('docs/export-moved.md'), 'utf8')).toBe(await rendered(note.id))
    expect(await readFile(file('docs/export-moved.md'), 'utf8')).toContain('changed by SQL')
    expect(await readFile(file('docs/export-ref.md'), 'utf8')).toContain('[[docs/export-moved]]')
    expect(await readFile(file('docs/index.md'), 'utf8')).toContain('export-moved')
    expect(JSON.parse(await readFile(report.reportFile, 'utf8')).kind).toBe('adr-003-store-export-legacy')
    // The lock is released: a server can start again.
    await (await holdInstanceLock('shared')).release()
  })

  it('verifies every file, not only pending ones: a file an unclean stop truncated is rewritten for the old image', async () => {
    const note = await createNote(vaultId, { type: 'docs', name: 'export-torn', body: 'whole body' })
    await flushProjections()
    await writeFile(file('docs/export-torn.md'), '')
    const report = await exportLegacyFiles()
    expect(report.ok).toBe(true)
    expect(await readFile(file('docs/export-torn.md'), 'utf8')).toBe(await rendered(note.id))
    expect(report.conflictCopies.some((c) => c.path === 'docs/export-torn.md')).toBe(true)
  })

  it('runs a pending rename refactor as the CLI, in a process that never loaded the note store', async () => {
    const target = await createNote(vaultId, { type: 'docs', name: 'cli-target', body: 'target' })
    const referrer = await createNote(vaultId, { type: 'docs', name: 'cli-ref', body: 'see [[docs/cli-target]]' })
    // The rename committed and its refactor job is left for later (the renaming process died), leased as a rename leases it.
    await db.execute(sql`UPDATE notes SET path = 'docs/cli-moved', name = 'cli-moved' WHERE id = ${target.id}`)
    await db.execute(sql`
      INSERT INTO jobs (kind, payload, lease_until, attempts)
      VALUES ('store_rename_refactor',
        ${JSON.stringify({ vaultId, noteId: target.id, fromPath: 'docs/cli-target', referrers: [referrer.id] })}::jsonb,
        now() + interval '1 hour', 1)`)
    const run = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/scripts/store-export-legacy.ts'], {
      cwd: join(import.meta.dirname, '..'),
      env: process.env,
    }).then(
      (out) => ({ code: 0, out: out.stdout + out.stderr }),
      (err: { code?: number; stdout?: string; stderr?: string }) => ({ code: err.code ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }),
    )
    expect(run.out).toContain('store-export-legacy: done')
    expect(run.code).toBe(0)
    const [row] = (await db.execute(sql`SELECT body FROM notes WHERE id = ${referrer.id}`)) as unknown as Array<{ body: string }>
    expect(row?.body).toBe('see [[docs/cli-moved]]')
  }, 60_000)
})
