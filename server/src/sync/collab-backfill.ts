/**
 * ADR-003 S2b part of the store migration (§8 steps 4-5, marker
 * `instance_state.collab_migrated_at`) and the collab side of boot (§7 steps
 * 4-5). Before S2b the relay kept each note's Yjs state in
 * `.crdt/<path>.bin`, keyed by path; S2b keeps it in `note_crdt`, keyed by
 * note id, and never reads a bin again.
 *
 * Per live note, one transaction each (a crash rolls back only the note in
 * flight; a rerun resumes):
 * - the bin at the note's current path is attached only if its text equals
 *   the note's row, its file or one of its revisions: a bin is keyed by path,
 *   so it may belong to a trashed predecessor at the same path, or hold a
 *   state the relay refused. Attached as is when it equals the row, else with
 *   a diff to the row's text on top (its history kept, never rebuilt, so open
 *   tabs and #720 browser copies holding it merge instead of doubling, #488);
 * - a bin that matches nothing is moved to `.migration/<date>/bins/` and the
 *   note is seeded on first open (a tab holding that history is then offered
 *   its text, not merged);
 * - no bin: nothing (seeded on first open).
 * The finish sets the marker and renames every vault's `.crdt/` to
 * `.crdt.pre-adr-003/` (kept for a code-only rollback, Q10).
 *
 * After a rollback to pre-S2b code (whose relay writes bins again) and back,
 * the bins it wrote are merged into `note_crdt` as Yjs updates (they descend
 * from the exported state), and `.crdt/` moves to `.crdt.rollback-<date>/`.
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { failpoint } from '../failpoints.js'
import { sameContent } from '../notes/frontmatter-order.js'
import { parseNote } from '../notes/okf.js'
import { foldPendingCollab } from '../notes/store.js'
import { BACKFILL_MARKER, storeTransaction, type Tx } from '../notes/store-tx.js'
import { crdtFile, loadCrdtState } from './crdt-store.js'
import { cloneDocument, compileChange, docState } from './live-docs.js'
import { appendUpdate, insertNoteCrdt, readNoteCrdt } from './note-crdt.js'

const BATCH = 100

/** What the S2b backfill (or a roll-forward) did, written to `DATA_DIR/collab-migration-report-<time>.json`. */
export interface CollabBackfillReport {
  kind: 'adr-003-collab-backfill' | 'adr-003-collab-roll-forward'
  startedAt: string
  finishedAt?: string
  notes: number
  /** Bins attached: equal to the row, or with a diff to the row on top. */
  attached: { equal: number; diffed: number }
  /** Bins merged into existing CRDT state (roll-forward). */
  merged: number
  /** Bins that matched neither row, file nor any revision, moved to `.migration/<date>/bins/`. */
  setAside: Array<{ noteId: string; vaultId: string; path: string; movedTo: string }>
  noBin: number
  /** Notes the S2a backfill has not processed yet: not done, so the marker stays unset. */
  waiting: number
  failed: Array<{ noteId: string; error: string }>
  renamed: string[]
}

interface Row {
  id: string
  vault_id: string
  path: string
  seq: string
  frontmatter: Record<string, unknown>
  body: string
}

/** True when the S2b backfill has finished on this instance. */
export async function collabMigrated(): Promise<boolean> {
  const [row] = (await db.execute(sql`SELECT collab_migrated_at FROM instance_state WHERE id = 'singleton'`)) as unknown as Array<{
    collab_migrated_at: string | null
  }>
  return Boolean(row?.collab_migrated_at)
}

async function fileBody(vaultId: string, path: string): Promise<string | null> {
  try {
    return parseNote(await readFile(join(config.dataDir, 'vaults', vaultId, `${path}.md`), 'utf8')).body
  } catch {
    return null
  }
}

/** Whether `body` is the text of the note's row, file or one of its revisions (§8 step 4a). */
async function knownText(tx: Tx, row: Row, body: string): Promise<boolean> {
  if (body === row.body || body === (await fileBody(row.vault_id, row.path))) return true
  const [revision] = (await tx.execute(sql`
    SELECT 1 FROM note_revisions WHERE note_id = ${row.id} AND body = ${body} LIMIT 1`)) as unknown as unknown[]
  return revision !== undefined
}

async function moveAside(vaultId: string, path: string, date: string): Promise<string> {
  const target = join(config.dataDir, 'vaults', vaultId, '.migration', date, 'bins', `${path}.bin`)
  await mkdir(dirname(target), { recursive: true })
  await rename(crdtFile(vaultId, path), target)
  return target
}

async function backfillNote(tx: Tx, id: string, report: CollabBackfillReport, date: string): Promise<void> {
  const [row] = (await tx.execute(sql`
    SELECT id, vault_id, path, seq, frontmatter, body FROM notes WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`)) as unknown as Row[]
  if (!row) return
  const [s2a] = (await tx.execute(
    sql`SELECT 1 FROM note_projections WHERE note_id = ${id} AND projection = ${BACKFILL_MARKER}`,
  )) as unknown as unknown[]
  if (!s2a) {
    report.waiting++
    return
  }
  const existing = await readNoteCrdt(tx, id)
  if (existing && report.kind === 'adr-003-collab-backfill') return
  const bin = await loadCrdtState(row.vault_id, row.path)
  if (!bin) {
    if (!existing) report.noBin++
    return
  }
  report.notes++
  const doc = new Y.Doc()
  let decoded = true
  try {
    Y.applyUpdate(doc, bin)
  } catch {
    decoded = false
  }
  if (existing) {
    // Roll-forward: the bin descends from the exported state; boot then rebases what old code changed in the row.
    if (decoded && (await appendUpdate(tx, existing, Y.diffUpdate(bin, Y.encodeStateVector(existing.doc)), { type: 'collab' }, { kind: 'rollback-bin' }))) {
      report.merged++
    }
    return
  }
  const state = docState(doc)
  if (!decoded || !(await knownText(tx, row, state.body))) {
    report.setAside.push({ noteId: id, vaultId: row.vault_id, path: row.path, movedTo: await moveAside(row.vault_id, row.path, date) })
    return
  }
  const target = { frontmatter: row.frontmatter, body: row.body }
  if (state.body === target.body && sameContent(state.frontmatter, target.frontmatter)) {
    report.attached.equal++
  } else {
    Y.applyUpdate(doc, compileChange(cloneDocument(doc), target))
    report.attached.diffed++
  }
  await insertNoteCrdt(tx, id, doc, Number(row.seq))
}

/** The vault directories that still have a `.crdt/` directory. */
async function vaultsWithBins(): Promise<string[]> {
  const root = join(config.dataDir, 'vaults')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name, '.crdt')
    if (await stat(dir).then((s) => s.isDirectory(), () => false)) found.push(join(root, entry.name))
  }
  return found
}

/**
 * Attaches (backfill) or merges (roll-forward) every live note's bin, then,
 * if no note failed or is still waiting for the S2a backfill, retires the
 * `.crdt/` directories (and, for the backfill, sets the marker).
 */
async function attachBins(kind: CollabBackfillReport['kind']): Promise<CollabBackfillReport> {
  const report: CollabBackfillReport = {
    kind,
    startedAt: new Date().toISOString(),
    notes: 0,
    attached: { equal: 0, diffed: 0 },
    merged: 0,
    setAside: [],
    noBin: 0,
    waiting: 0,
    failed: [],
    renamed: [],
  }
  const date = report.startedAt.slice(0, 10)
  let after = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const ids = (await db.execute(sql`
      SELECT id FROM notes WHERE id > ${after}::uuid AND deleted_at IS NULL ORDER BY id LIMIT ${BATCH}`)) as unknown as Array<{ id: string }>
    if (ids.length === 0) break
    after = ids.at(-1)!.id
    for (const { id } of ids) {
      try {
        await storeTransaction([id], (tx) => backfillNote(tx, id, report, date))
      } catch (err) {
        report.failed.push({ noteId: id, error: err instanceof Error ? err.message : String(err) })
        console.error(`[collab] ${kind} of note ${id} failed:`, err)
      }
      failpoint('migration.mid-batch')
    }
  }
  if (report.failed.length === 0 && report.waiting === 0) {
    if (kind === 'adr-003-collab-backfill') {
      await db.execute(sql`
        INSERT INTO instance_state (id, collab_migrated_at) VALUES ('singleton', now())
        ON CONFLICT (id) DO UPDATE SET collab_migrated_at = now()`)
    }
    const suffix = kind === 'adr-003-collab-backfill' ? '.crdt.pre-adr-003' : `.crdt.rollback-${report.startedAt.replace(/[:.]/g, '-')}`
    for (const vault of await vaultsWithBins()) {
      let target = join(vault, suffix)
      if (await stat(target).then(() => true, () => false)) target = `${target}-${report.startedAt.replace(/[:.]/g, '-')}`
      await rename(join(vault, '.crdt'), target)
      report.renamed.push(target)
    }
  }
  report.finishedAt = new Date().toISOString()
  const file = join(config.dataDir, `collab-migration-report-${report.finishedAt.replace(/[:.]/g, '-')}.json`)
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    `[collab] ${kind}: ${report.notes} bins, attached ${JSON.stringify(report.attached)}, merged ${report.merged}, ` +
      `${report.setAside.length} set aside, ${report.waiting} waiting for the store backfill, ${report.failed.length} failed; report ${file}`,
  )
  return report
}

/** The S2b backfill (§8 step 4-5); runs at boot while `collab_migrated_at` is unset, and resumes after a crash. */
export function runCollabBackfill(): Promise<CollabBackfillReport> {
  return attachBins('adr-003-collab-backfill')
}

/**
 * The collab part of boot, before `listen` (§7 steps 2, 4-5): the S2b
 * backfill while its marker is unset; after a rollback, the bins the old
 * relay wrote merged in; then every note whose row moved past its CRDT
 * state rebased, and every unfolded tail folded. One note's failure is
 * logged and counted; boot never stops for it.
 */
export async function bootCollab(): Promise<{ backfill: CollabBackfillReport | null; folded: number; failed: number }> {
  let backfill: CollabBackfillReport | null = null
  if (!(await collabMigrated())) backfill = await runCollabBackfill()
  else if ((await vaultsWithBins()).length > 0) backfill = await attachBins('adr-003-collab-roll-forward')
  const { folded, failed } = await foldPendingCollab()
  return { backfill, folded, failed }
}
