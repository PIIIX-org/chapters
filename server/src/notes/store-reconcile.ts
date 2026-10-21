/**
 * ADR-003 S2a: the store backfill (§8 step 2-3, marker
 * `instance_state.store_migrated_at`) and the reconciliation that runs at
 * every boot (§7 boot step 3). Both work one note per transaction (never
 * thousands of advisory locks in one), so a crash rolls back only the note
 * in flight and a rerun resumes.
 *
 * Neither reads, moves nor renames `.crdt/`: the unchanged S2a relay still
 * loads and saves its bins by path (§8 step 2e).
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { sql } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { failpoint } from '../failpoints.js'
import { atomicWrite } from './atomic-write.js'
import { orderKeys, sameContent } from './frontmatter-order.js'
import { parseNote, type OkfNote } from './okf.js'
import { PROJECTION_VERSIONS, flushProjections, noteFileRel, renderNoteFile, sha256, verifyAllProjections } from './projector.js'
import type { ShutdownKind } from '../lifecycle.js'
import {
  BACKFILL_MARKER,
  enqueueEmbeddingTx,
  replaceLinks,
  setStoreMigrationPending,
  storeTransaction,
  type Tx,
} from './store-tx.js'

const BATCH = 100

/** Actor of the revisions the store itself writes: `actor_type` has no `system` value, so `collab` with the kind in `actor_detail`. */
const MIGRATION_ACTOR = { type: 'collab' as const }

interface Row {
  id: string
  vault_id: string
  path: string
  deleted_at: string | null
  seq: string
  frontmatter: Record<string, unknown>
  frontmatter_src: Record<string, unknown> | null
  body: string
}

/** Counts per class (§8 step 2b), the Q5 conflict list and the files that change bytes. */
export interface BackfillReport {
  kind: 'adr-003-store-backfill'
  startedAt: string
  finishedAt?: string
  notes: number
  skipped: number
  file: Record<'consistent' | 'missing' | 'unparseable' | 'differs', number>
  projection: Record<'applied' | 'adopted' | 'pending', number>
  revisions: { adopted: number; inserted: number }
  conflicts: Array<{ noteId: string; vaultId: string; path: string; rowHash: string; fileHash: string; resolution: 'file-wins' }>
  failed: Array<{ noteId: string; error: string }>
  tempFilesRemoved: number
}

async function readMaybe(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Gives the note a revision at its current `seq` (invariant I2) when it has
 * none: the newest revision takes the `seq` when it has none and holds the
 * row's content, otherwise a `migration:backfill` revision is inserted.
 * Returns what it did.
 */
async function revisionAtSeq(tx: Tx, noteId: string, reason: string): Promise<'present' | 'adopted' | 'inserted'> {
  const [present] = (await tx.execute(sql`
    SELECT 1 FROM note_revisions r JOIN notes n ON n.id = r.note_id WHERE n.id = ${noteId} AND r.seq = n.seq`)) as unknown as unknown[]
  if (present) return 'present'
  const adopted = (await tx.execute(sql`
    UPDATE note_revisions r SET seq = n.seq FROM notes n
    WHERE r.id = (
      SELECT id FROM note_revisions WHERE note_id = ${noteId}
        AND action NOT IN ('quarantine', 'proposal', 'restore_point')
      ORDER BY ord DESC LIMIT 1)
      AND n.id = r.note_id AND r.seq IS NULL AND r.body = n.body AND r.frontmatter = n.frontmatter
    RETURNING r.id`)) as unknown as unknown[]
  if (adopted.length > 0) return 'adopted'
  await tx.execute(sql`
    INSERT INTO note_revisions (note_id, actor_type, action, frontmatter, body, seq, actor_detail)
    SELECT id, ${MIGRATION_ACTOR.type}, 'migration:backfill', frontmatter, body, seq,
      jsonb_build_object('kind', 'system', 'reason', ${reason}::text)
    FROM notes WHERE id = ${noteId}`)
  return 'inserted'
}

/** What reconcileStore found: rows it gave projection rows, targets it raised, revisions it added, notes it could not fix. */
export interface Reconciled {
  projections: number
  raised: number
  revisions: number
  failed: number
}

/**
 * Boot step 3 (§7), on every boot and after a backup restore: finds rows
 * written around the store (old code during a rollback, restores, manual
 * SQL) with index-backed anti-joins and fills in what the store would have
 * written: projection rows (the projector then verifies each file under the
 * ownership rules, adopting a file whose content equals the row), raised
 * projection targets, and a revision at every note's current `seq`.
 * One failure is logged and skipped; reconciliation never aborts boot.
 */
export async function reconcileStore(): Promise<Reconciled> {
  const inserted = (await db.execute(sql`
    INSERT INTO note_projections (note_id, projection, target_seq)
    SELECT n.id, p.kind, n.seq FROM notes n CROSS JOIN (VALUES ('file'), ('dir_index')) AS p(kind)
    WHERE NOT EXISTS (SELECT 1 FROM note_projections x WHERE x.note_id = n.id AND x.projection = p.kind)
    ON CONFLICT DO NOTHING
    RETURNING note_id`)) as unknown as unknown[]
  const raised = (await db.execute(sql`
    UPDATE note_projections p SET target_seq = n.seq, attempts = 0, updated_at = now()
    FROM notes n WHERE p.note_id = n.id AND p.target_seq < n.seq AND p.projection IN ('file', 'dir_index')
    RETURNING p.note_id`)) as unknown as unknown[]
  // Version bumps (§7 boot step 8): a renderer that changed re-renders its projections.
  for (const [projection, version] of Object.entries(PROJECTION_VERSIONS)) {
    await db.execute(sql`
      UPDATE note_projections SET applied_seq = 0, updated_at = now()
      WHERE projection = ${projection} AND index_version < ${version} AND applied_seq > 0`)
  }
  const gaps = (await db.execute(sql`
    SELECT n.id FROM notes n
    WHERE NOT EXISTS (SELECT 1 FROM note_revisions r WHERE r.note_id = n.id AND r.seq = n.seq)`)) as unknown as Array<{ id: string }>
  let revisions = 0
  let failed = 0
  for (const { id } of gaps) {
    try {
      const done = await storeTransaction([id], (tx) => revisionAtSeq(tx, id, 'boot-reconcile'))
      if (done !== 'present') revisions++
    } catch (err) {
      failed++
      console.error(`[store] boot reconciliation of note ${id} failed:`, err)
    }
  }
  return { projections: inserted.length, raised: raised.length, revisions, failed }
}

/**
 * The store's part of boot (ADR-003 §7 boot steps 2-3), before `listen`:
 * 1. clear the projection claims a stopped or killed process left (their
 *    lease would keep those projections from running for up to a minute;
 *    nothing else runs yet, and file IO stays guarded by the path lock);
 * 2. the one-time backfill while `store_migrated_at` is unset; while it has
 *    failures the marker stays unset and reconciliation does not run, so a
 *    note the backfill could not read gets no projection rows and is
 *    backfilled (file wins, Q5) on a later boot, never skipped as done;
 * 3. reconciliation of rows written around the store;
 * 4. boot step 7: after an `unclean` or `unknown` previous shutdown
 *    (`lastShutdown`), every `file` and `dir_index` projection is marked for
 *    verification against the disk (files are written without fsync, so a
 *    power loss can leave one truncated: conflict copy, then rewrite);
 * 5. the projector runs until nothing is pending, so files equal rows when
 *    serving starts.
 */
export async function bootStore(
  options: { lastShutdown?: ShutdownKind } = {},
): Promise<{ migrated: boolean; reconciled: Reconciled | null; verified: number }> {
  await db.execute(sql`UPDATE note_projections SET lease_until = NULL WHERE lease_until IS NOT NULL`)
  if (!(await storeMigrated())) {
    await runStoreBackfill()
    if (!(await storeMigrated())) {
      // Notes the backfill could not process are refused for writes until it can (Q5).
      setStoreMigrationPending(true)
      return { migrated: false, reconciled: null, verified: 0 }
    }
  } else {
    const removed = await sweepTempFiles()
    if (removed > 0) console.log(`removed ${removed} orphan temp file(s)`)
  }
  setStoreMigrationPending(false)
  const reconciled = await reconcileStore()
  const verified = options.lastShutdown && options.lastShutdown !== 'graceful' ? await verifyAllProjections() : 0
  await flushProjections()
  return { migrated: true, reconciled, verified }
}

/** True when the S2a backfill has finished on this instance. */
export async function storeMigrated(): Promise<boolean> {
  const [row] = (await db.execute(sql`SELECT store_migrated_at FROM instance_state WHERE id = 'singleton'`)) as unknown as Array<{
    store_migrated_at: string | null
  }>
  return Boolean(row?.store_migrated_at)
}

/**
 * The S2a backfill (§8 step 2): every note, live and trashed, by id in
 * batches, one transaction per note under its advisory lock. A note is done
 * once it has its `backfill` marker (a `note_projections` row written in its
 * backfill transaction, or at create), so a rerun skips it; a later write's
 * projection rows never count as done.
 *
 * Per note: read the row and its file (`<path>.md`, or `.trash/<id>.md`);
 * choose the content (Q5: a file that parses and differs from the row wins,
 * and the row's text is kept as a `migration:row-kept` revision; an
 * unparseable file is copied to `.migration/<date>/unparseable/`);
 * `frontmatter_src` from the chosen source's key order; a revision at the
 * note's `seq`; and the `file` projection: applied when the rendering equals
 * the bytes on disk, adopted when the file parses to the chosen content
 * (its bytes stay), pending otherwise (the projector conflict-copies the old
 * file before rewriting it). `dir_index` is left pending: the projector
 * compares and writes only what differs.
 */
export async function runStoreBackfill(): Promise<BackfillReport> {
  const report: BackfillReport = {
    kind: 'adr-003-store-backfill',
    startedAt: new Date().toISOString(),
    notes: 0,
    skipped: 0,
    file: { consistent: 0, missing: 0, unparseable: 0, differs: 0 },
    projection: { applied: 0, adopted: 0, pending: 0 },
    revisions: { adopted: 0, inserted: 0 },
    conflicts: [],
    failed: [],
    tempFilesRemoved: 0,
  }
  const date = report.startedAt.slice(0, 10)
  let after = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const ids = (await db.execute(sql`
      SELECT id FROM notes WHERE id > ${after}::uuid ORDER BY id LIMIT ${BATCH}`)) as unknown as Array<{ id: string }>
    if (ids.length === 0) break
    after = ids.at(-1)!.id
    for (const { id } of ids) {
      try {
        const done = await storeTransaction([id], (tx) => backfillNote(tx, id, report, date))
        if (done) report.notes++
        else report.skipped++
      } catch (err) {
        report.failed.push({ noteId: id, error: err instanceof Error ? err.message : String(err) })
        console.error(`[store] backfill of note ${id} failed:`, err)
      }
      failpoint('migration.mid-batch')
    }
  }
  report.tempFilesRemoved = await sweepTempFiles()
  if (report.failed.length === 0) {
    await db.execute(sql`
      INSERT INTO instance_state (id, store_migrated_at) VALUES ('singleton', now())
      ON CONFLICT (id) DO UPDATE SET store_migrated_at = now()`)
  }
  report.finishedAt = new Date().toISOString()
  const file = join(config.dataDir, `migration-report-${report.finishedAt.replace(/[:.]/g, '-')}.json`)
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    `[store] backfill: ${report.notes} notes (${report.skipped} already done), files ${JSON.stringify(report.file)}, ` +
      `projections ${JSON.stringify(report.projection)}, ${report.conflicts.length} conflict(s), ${report.failed.length} failed; report ${file}`,
  )
  return report
}

async function backfillNote(tx: Tx, id: string, report: BackfillReport, date: string): Promise<boolean> {
  const [done] = (await tx.execute(
    sql`SELECT 1 FROM note_projections WHERE note_id = ${id} AND projection = ${BACKFILL_MARKER}`,
  )) as unknown as unknown[]
  if (done) return false
  const [row] = (await tx.execute(sql`
    SELECT id, vault_id, path, deleted_at, seq, frontmatter, frontmatter_src, body FROM notes WHERE id = ${id} FOR UPDATE`)) as unknown as Row[]
  if (!row) return false
  const rel = noteFileRel({ id: row.id, path: row.path, deletedAt: row.deleted_at })
  const abs = join(config.dataDir, 'vaults', row.vault_id, rel)
  const disk = await readMaybe(abs)
  let parsed: OkfNote | null = null
  if (disk) {
    try {
      parsed = parseNote(disk.toString('utf8'))
    } catch {
      parsed = null
    }
  }
  let order: Record<string, unknown> = row.frontmatter_src && sameContent(row.frontmatter_src, row.frontmatter) ? row.frontmatter_src : row.frontmatter
  if (!disk) report.file.missing++
  else if (!parsed) {
    report.file.unparseable++
    await atomicWrite(join(config.dataDir, 'vaults', row.vault_id, '.migration', date, 'unparseable', rel), disk)
  } else if (parsed.body === row.body && sameContent(parsed.frontmatter, row.frontmatter)) {
    report.file.consistent++
    order = orderKeys(parsed.frontmatter, row.frontmatter)
  } else {
    // Q5: the file wins; the row's text is kept as a revision first.
    report.file.differs++
    report.conflicts.push({
      noteId: row.id,
      vaultId: row.vault_id,
      path: rel,
      rowHash: sha256(renderNoteFile({ frontmatter: row.frontmatter, frontmatterSrc: null, body: row.body })),
      fileHash: sha256(disk),
      resolution: 'file-wins',
    })
    await tx.execute(sql`
      INSERT INTO note_revisions (note_id, actor_type, action, frontmatter, body, seq, actor_detail)
      SELECT id, ${MIGRATION_ACTOR.type}, 'migration:row-kept', frontmatter, body,
        CASE WHEN EXISTS (SELECT 1 FROM note_revisions r WHERE r.note_id = n.id AND r.seq = n.seq) THEN NULL ELSE seq END,
        '{"kind":"system","reason":"migration: file differs from row"}'::jsonb
      FROM notes n WHERE id = ${id}`)
    const frontmatter = { ...parsed.frontmatter, type: row.frontmatter.type ?? parsed.frontmatter.type }
    await tx.execute(sql`
      UPDATE notes SET frontmatter = ${JSON.stringify(frontmatter)}::jsonb, body = ${parsed.body}, updated_at = now() WHERE id = ${id}`)
    await tx.execute(sql`
      INSERT INTO note_revisions (note_id, actor_type, action, frontmatter, body, seq, actor_detail)
      SELECT id, ${MIGRATION_ACTOR.type}, 'migration:file', frontmatter, body, seq,
        '{"kind":"system","reason":"migration: the file wins (Q5)"}'::jsonb
      FROM notes WHERE id = ${id}`)
    // As every store write: the new body's links and an embedding of it.
    await replaceLinks(tx, id, parsed.body)
    const [moved] = (await tx.execute(sql`SELECT seq FROM notes WHERE id = ${id}`)) as unknown as Array<{ seq: string }>
    await enqueueEmbeddingTx(tx, id, Number(moved!.seq))
    row.frontmatter = frontmatter
    row.body = parsed.body
    order = orderKeys(parsed.frontmatter, frontmatter)
  }
  await tx.execute(sql`UPDATE notes SET frontmatter_src = ${JSON.stringify(order)}::json WHERE id = ${id}`)
  const revision = await revisionAtSeq(tx, id, 'migration')
  if (revision === 'adopted') report.revisions.adopted++
  if (revision === 'inserted') report.revisions.inserted++
  const [current] = (await tx.execute(sql`SELECT seq FROM notes WHERE id = ${id}`)) as unknown as Array<{ seq: string }>
  const seq = current!.seq
  const rendered = renderNoteFile({ frontmatter: row.frontmatter, frontmatterSrc: order, body: row.body })
  const adoptable = parsed !== null && parsed.body === row.body && sameContent(parsed.frontmatter, row.frontmatter)
  let fileApplied = 0
  if (disk && adoptable) {
    report.projection[disk.equals(Buffer.from(rendered, 'utf8')) ? 'applied' : 'adopted']++
    fileApplied = Number(seq)
    await tx.execute(sql`
      INSERT INTO projected_files (vault_id, path, owner_kind, owner_id, applied_hash, applied_seq)
      VALUES (${row.vault_id}, ${rel}, ${row.deleted_at ? 'trash' : 'note'}, ${row.id}, ${sha256(disk)}, ${seq})
      ON CONFLICT (vault_id, path) DO UPDATE SET owner_kind = EXCLUDED.owner_kind, owner_id = EXCLUDED.owner_id,
        applied_hash = EXCLUDED.applied_hash, applied_seq = EXCLUDED.applied_seq, written_at = now()`)
  } else report.projection.pending++
  // The per-note done marker, in this transaction: a later write (which raises
  // the file and dir_index rows) never makes a rerun skip a note it did not process.
  await tx.execute(sql`
    INSERT INTO note_projections (note_id, projection, target_seq, applied_seq, index_version)
    VALUES (${id}, 'file', ${seq}, ${fileApplied}, ${fileApplied ? PROJECTION_VERSIONS.file : 0}),
           (${id}, 'dir_index', ${seq}, 0, 0),
           (${id}, ${BACKFILL_MARKER}, ${seq}, ${seq}, 0)
    ON CONFLICT DO NOTHING`)
  return true
}

/** The atomic-write.ts temp name: `<file>.<pid>.<12 hex>.tmp`. */
const TEMP_FILE = /\.\d+\.[0-9a-f]{12}\.tmp$/

/**
 * Deletes the temp files a crash between write and rename left under
 * `DATA_DIR/vaults` (#489). Only safe while no writer runs: before `listen`.
 */
export async function sweepTempFiles(): Promise<number> {
  const root = join(config.dataDir, 'vaults')
  let removed = 0
  async function visit(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && TEMP_FILE.test(entry.name)) {
        await rm(child, { force: true })
        removed++
        console.warn(`[store] removed orphan temp file ${relative(root, child).split(sep).join('/')}`)
      }
    }
  }
  await mkdir(root, { recursive: true })
  await stat(root)
  await visit(root)
  return removed
}
