/**
 * The doctor (ADR-003 S6, #495): compares every copy of a note's state with
 * the note row, which is the authority, and reports each mismatch by class.
 *
 * - file: the `.md` file (or `.trash/<id>.md`) of a note whose `file`
 *   projection is applied at the row's `seq`: missing, unparseable, content
 *   different from the row, bytes the projector did not write (a hand or
 *   `git` edit, Q2), or no `projected_files` record; generated `index.md`
 *   files; orphan `.md` files; conflict copies waiting in `.conflicts/`,
 *   except those of the S2a backfill (below).
 * - projections: a note without a `file` projection row, a projection whose
 *   render failed (`last_error`), one applied by an older renderer version.
 * - row: no revision at the row's `seq`, or that revision's content differs.
 * - CRDT: `note_crdt` fold errors, rejected updates, an acknowledged tail
 *   left unfolded for over STALE_TAIL_MINUTES, and a snapshot ⊕ tail that
 *   differs from the row it is folded into; until the S2b collab backfill
 *   has finished, also the `.crdt` bins it has still to read (live notes
 *   with no `note_crdt` row): text different from the row, undecodable, or
 *   no live note. Bins S2b no longer reads are not problems.
 * - FTS: the stored `fts` vector differs from the one the row gives.
 * - vectors: a live note with no embedding and no job, or whose job for its
 *   current `seq` failed.
 * - links: the `note_links` rows (targets and lines) differ from the wikilinks of the body.
 * - blocks (repository files, #413): a file with no blocks of its current
 *   content and embed key (`blocks-missing`: no extraction job for them, or
 *   one that finished without them), or whose extraction job for them
 *   failed (`blocks-failed`). Checked on a whole-instance run or with
 *   `repositoryId`, not when the run is scoped to a vault.
 *
 * Work that is still running (pending projections, embedding jobs, CRDT
 * tails not folded yet) is listed apart and is not a problem. So is `info`:
 * a `.conflicts/` copy holding the same bytes as the S2a backfill's
 * `.migration/<date>/unparseable/` copy of that path (the backfill kept the
 * file it could not parse, and the projector copied it again before
 * rewriting it from the row; #908). The report's `status` is `ok` (no
 * problem), `repairable` (every problem is one `repair` re-raises) or
 * `broken` (at least one needs a person). The doctor
 * reads a snapshot while the server may be writing: run it idle (or with the
 * server stopped) for an exact answer.
 *
 * Read-only by default. `repair` re-raises derived state and never invents
 * or overwrites note content: a `file` projection is reset so the projector renders it again
 * (under the ownership rules, so bytes it did not write are copied to
 * `.conflicts/` first), a missing projection row is created, a failed one is
 * retried, an outdated one re-rendered, link rows are derived again from the
 * body under the note lock, an embedding or extraction job is queued, and a fold error or
 * stale tail is folded as boot does (S2b `foldPendingCollab` for that note,
 * under its lock: acknowledged collab typing reaches the row, the one repair
 * that writes a row, and only from the note's own CRDT log). The running
 * server's projector and embedding and extraction workers pick these up (they poll), or the
 * next start does. Every other class is report-only.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as Y from 'yjs'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { onJobConflict } from '../jobs/durable.js'
import { EXTRACTION_JOB, extractionJobKeySql, hasCurrentBlocksSql } from '../repositories/extraction-queue.js'
import { EMBEDDING_JOB, embeddingJobKeySql } from '../search/embedding-queue.js'
import { sameContent } from './frontmatter-order.js'
import { compareNoteFile, orphanFiles } from './integrity.js'
import { PROJECTION_VERSIONS, noteFileRel, sha256 } from './projector.js'
import { foldPendingCollab, vaultDir } from './store.js'
import { docState } from '../sync/live-docs.js'
import { linkRows, replaceLinks, storeTransaction, type Tx } from './store-tx.js'

export const DOCTOR_CLASSES = [
  'file-missing',
  'file-unparseable',
  'file-differs',
  'file-edited',
  'file-unrecorded',
  'file-orphan',
  'conflict-copy',
  'projection-missing',
  'projection-failed',
  'projection-outdated',
  'revision-missing',
  'revision-differs',
  'crdt-bin-differs',
  'crdt-bin-undecodable',
  'crdt-bin-orphan',
  'crdt-fold-error',
  'crdt-rejected-update',
  'crdt-snapshot-differs',
  'crdt-tail-stale',
  'fts-stale',
  'vector-missing',
  'vector-failed',
  'links-differ',
  'blocks-missing',
  'blocks-failed',
] as const

export type DoctorClass = (typeof DOCTOR_CLASSES)[number]

export interface DoctorProblem {
  class: DoctorClass
  /** The note's vault; '' for a repository file's problem (`repositoryId`). */
  vaultId: string
  vaultName: string
  /** Set on a repository file's problem (`blocks-*`): its repository; `path` is the file's. */
  repositoryId?: string
  repositoryName?: string
  /** Vault-relative: a note path, a file (`a/index.md`, `.trash/<id>.md`, `.conflicts/…`) or a bin (`.crdt/a.bin`); or a repository file's path. */
  path: string
  noteId: string | null
  /** A repository file's problem: the `repository_files` id. */
  fileId?: string
  detail: string
  /** `--repair` can re-raise the derived state behind it. */
  repairable: boolean
  /** Set with `repair`: the re-raise was queued. */
  repaired?: boolean
}

export interface DoctorPending {
  kind: 'projection' | 'embedding' | 'crdt-tail' | 'crdt-rebase' | 'crdt-bin' | 'extraction'
  /** As in `DoctorProblem`: '' with `repositoryId` for an extraction. */
  vaultId: string
  vaultName: string
  repositoryId?: string
  repositoryName?: string
  path: string
  /** A note's id, or a repository file's for an extraction. */
  noteId: string
  detail: string
}

/** Not a problem: something an upgrade left by design, for the operator to review (#908). */
export interface DoctorInfo {
  kind: 'migration-copy'
  vaultId: string
  vaultName: string
  path: string
  detail: string
}

export interface DoctorReport {
  kind: 'elara-doctor'
  startedAt: string
  finishedAt: string
  repair: boolean
  /** No problems (pending work and info do not count). */
  ok: boolean
  /** `ok`: no problems; `repairable`: every problem is `repairable`; `broken`: at least one is not. */
  status: 'ok' | 'repairable' | 'broken'
  checked: { notes: number; files: number; bins: number; crdtRows: number; repositoryFiles: number }
  counts: Partial<Record<DoctorClass, number>>
  problems: DoctorProblem[]
  pending: DoctorPending[]
  info: DoctorInfo[]
}

type Client = Tx | typeof db

const BATCH = 500

/** An unfolded collab tail older than this is a problem, not work in flight (the relay folds within seconds of the last keystroke). */
export const STALE_TAIL_MINUTES = 10

const REPAIRABLE: ReadonlySet<DoctorClass> = new Set<DoctorClass>([
  'crdt-fold-error',
  'crdt-tail-stale',
  'file-missing',
  'file-unparseable',
  'file-differs',
  'file-edited',
  'file-unrecorded',
  'projection-missing',
  'projection-failed',
  'projection-outdated',
  'vector-missing',
  'vector-failed',
  'links-differ',
  'blocks-missing',
  'blocks-failed',
])

interface NoteRow {
  id: string
  vault_id: string
  vault_name: string
  path: string
  deleted_at: string | null
  seq: string
  frontmatter: Record<string, unknown>
  body: string
  no_embedding: boolean
  fts_stale: boolean
  has_revision: boolean
  revision_same: boolean | null
  links: string[]
}

interface ProjectionRow {
  note_id: string
  projection: string
  target_seq: string
  applied_seq: string
  index_version: number
  last_error: string | null
}

interface ProjectedFileRow {
  vault_id: string
  path: string
  owner_kind: string
  owner_id: string | null
  applied_hash: string
}

interface CrdtRow {
  note_id: string
  snapshot: Uint8Array
  snapshot_through: string
  folded_through: string
  folded_seq: string
  fold_error: string | null
  rejected: number
  tail: number
  tail_stale: boolean
}

async function readMaybe(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Every file under `dir` (vault-relative to `root`), recursively. */
async function listFiles(root: string, dir: string): Promise<string[]> {
  const found: string[] = []
  async function visit(rel: string): Promise<void> {
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) found.push(child)
    }
  }
  await visit(dir)
  return found.sort()
}

/** The projector's copy name (projector.ts `conflictCopy`): `.conflicts/<path without .md>.<UTC stamp>.md`. */
const CONFLICT_COPY = /^\.conflicts\/(.+)\.\d{8}T\d{9}Z\.md$/
/** Where the S2a backfill keeps a file it could not parse (store-reconcile.ts `backfillNote`): `.migration/<date>/unparseable/<path>`. */
const UNPARSEABLE_KEPT = /^\.migration\/[^/]+\/unparseable\/(.+)$/

/** The first of `candidates` (vault-relative) holding the same bytes as `copy`, or null. */
async function sameBytes(root: string, copy: string, candidates: readonly string[]): Promise<string | null> {
  if (candidates.length === 0) return null
  const bytes = await readFile(join(root, copy))
  for (const candidate of candidates) {
    if ((await readMaybe(join(root, candidate)))?.equals(bytes)) return candidate
  }
  return null
}

function contentDiff(a: { frontmatter: Record<string, unknown>; body: string }, row: { frontmatter: Record<string, unknown>; body: string }): string | null {
  const parts: string[] = []
  if (!sameContent(a.frontmatter, row.frontmatter)) parts.push('frontmatter')
  if (a.body !== row.body) parts.push(`body (${a.body.length} vs row ${row.body.length} chars)`)
  return parts.length > 0 ? `differs from the row: ${parts.join(', ')}` : null
}

/** The stored `fts` against the generated-column expression of migration 0002. */
const FTS_STALE = sql`n.fts IS DISTINCT FROM to_tsvector('english', coalesce(n.path, '') || ' ' || coalesce(n.frontmatter::text, '') || ' ' || coalesce(n.body, ''))`

export async function runDoctor(
  options: { vaultId?: string; repositoryId?: string; repair?: boolean; client?: Client; staleTailMinutes?: number } = {},
): Promise<DoctorReport> {
  const client = options.client ?? db
  const repair = options.repair ?? false
  const staleTailMinutes = options.staleTailMinutes ?? STALE_TAIL_MINUTES
  // S2b (§8 step 4): once the collab backfill finished, `.crdt/` bins are never read again (a rollback's bins merge at the next boot).
  const [instance] = (await client.execute(sql`SELECT collab_migrated_at FROM instance_state WHERE id = 'singleton'`)) as unknown as Array<{
    collab_migrated_at: string | null
  }>
  const collabMigrated = Boolean(instance?.collab_migrated_at)
  const crdtNotes = new Set<string>() // notes whose collab state is in note_crdt: their bins are not read either
  const startedAt = new Date().toISOString()
  const problems: DoctorProblem[] = []
  const pending: DoctorPending[] = []
  const info: DoctorInfo[] = []
  const checked = { notes: 0, files: 0, bins: 0, crdtRows: 0, repositoryFiles: 0 }
  const vaultFilter = (column: SQL): SQL => (options.vaultId ? sql`AND ${column} = ${options.vaultId}` : sql``)

  const vaults = (await client.execute(sql`
    SELECT id, name FROM vaults WHERE deleted_at IS NULL ${vaultFilter(sql`id`)} ORDER BY name, id`)) as unknown as Array<{
    id: string
    name: string
  }>
  const vaultName = new Map(vaults.map((v) => [v.id, v.name]))
  const problem = (p: Omit<DoctorProblem, 'repairable' | 'vaultName'>): void => {
    problems.push({ ...p, vaultName: vaultName.get(p.vaultId) ?? '', repairable: REPAIRABLE.has(p.class) })
  }

  // What the projector last wrote, per vault and path.
  const projected = new Map<string, ProjectedFileRow>()
  for (const row of (await client.execute(sql`
    SELECT f.vault_id, f.path, f.owner_kind, f.owner_id, f.applied_hash FROM projected_files f
    JOIN vaults v ON v.id = f.vault_id WHERE v.deleted_at IS NULL ${vaultFilter(sql`f.vault_id`)}`)) as unknown as ProjectedFileRow[]) {
    projected.set(`${row.vault_id}/${row.path}`, row)
  }

  const livePaths = new Map<string, string>() // `${vault}/${path}` -> note id
  let after = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const notes = (await client.execute(sql`
      SELECT n.id, n.vault_id, v.name AS vault_name, n.path, n.deleted_at, n.seq, n.frontmatter, n.body,
        n.embedding IS NULL AS no_embedding, ${FTS_STALE} AS fts_stale,
        r.id IS NOT NULL AS has_revision, (r.frontmatter = n.frontmatter AND r.body = n.body) AS revision_same,
        COALESCE((SELECT array_agg(CASE WHEN l.start_line = 0 THEN l.target_path || ' (no line)' WHEN l.start_line = l.end_line THEN l.target_path || '#L' || l.start_line
          ELSE l.target_path || '#L' || l.start_line || '-L' || l.end_line END) FROM note_links l WHERE l.source_note_id = n.id), '{}') AS links
      FROM notes n
      JOIN vaults v ON v.id = n.vault_id
      LEFT JOIN note_revisions r ON r.note_id = n.id AND r.seq = n.seq
      WHERE v.deleted_at IS NULL AND n.id > ${after} ${vaultFilter(sql`n.vault_id`)}
      ORDER BY n.id LIMIT ${BATCH}`)) as unknown as NoteRow[]
    if (notes.length === 0) break
    after = notes[notes.length - 1]!.id
    const ids = `{${notes.map((n) => n.id).join(',')}}`

    const projections = new Map<string, ProjectionRow>()
    for (const row of (await client.execute(sql`
      SELECT note_id, projection, target_seq, applied_seq, index_version, last_error FROM note_projections
      WHERE note_id = ANY(${ids}::uuid[]) AND projection IN ('file', 'dir_index')`)) as unknown as ProjectionRow[]) {
      projections.set(`${row.note_id}/${row.projection}`, row)
    }
    const embedJobs = new Map<string, { done: boolean; last_error: string | null }>()
    for (const row of (await client.execute(sql`
      SELECT n.id, j.done_at IS NOT NULL AS done, j.last_error FROM notes n
      JOIN jobs j ON j.idempotency_key = ${embeddingJobKeySql(sql`n.id`, sql`n.seq`)}
      WHERE n.id = ANY(${ids}::uuid[])`)) as unknown as Array<{ id: string; done: boolean; last_error: string | null }>) {
      embedJobs.set(row.id, row)
    }
    const crdt = (await client.execute(sql`
      SELECT c.note_id, c.snapshot, c.snapshot_through, c.folded_through, c.folded_seq, c.fold_error,
        (SELECT count(*)::int FROM note_updates u WHERE u.note_id = c.note_id AND u.rejected_at IS NOT NULL) AS rejected,
        (SELECT count(*)::int FROM note_updates u WHERE u.note_id = c.note_id AND u.rejected_at IS NULL AND u.id > c.folded_through) AS tail,
        EXISTS (SELECT 1 FROM note_updates u WHERE u.note_id = c.note_id AND u.rejected_at IS NULL AND u.id > c.folded_through
          AND u.created_at < now() - ${staleTailMinutes} * interval '1 minute') AS tail_stale
      FROM note_crdt c WHERE c.note_id = ANY(${ids}::uuid[])`)) as unknown as CrdtRow[]
    const crdtOf = new Map(crdt.map((c) => [c.note_id, c]))

    for (const note of notes) {
      checked.notes++
      const live = !note.deleted_at
      const seq = Number(note.seq)
      const at = { vaultId: note.vault_id, noteId: note.id }
      const pendingAt = { vaultId: note.vault_id, vaultName: note.vault_name, path: note.path, noteId: note.id }
      if (live) livePaths.set(`${note.vault_id}/${note.path}`, note.id)

      // Row and revision.
      if (!note.has_revision) problem({ ...at, class: 'revision-missing', path: note.path, detail: `no revision at seq ${seq}` })
      else if (!note.revision_same) {
        problem({ ...at, class: 'revision-differs', path: note.path, detail: `the revision at seq ${seq} holds other content than the row` })
      }
      if (note.fts_stale) problem({ ...at, class: 'fts-stale', path: note.path, detail: 'stored fts differs from the row' })

      // Projections and the file.
      const rel = noteFileRel({ id: note.id, path: note.path, deletedAt: note.deleted_at })
      const file = projections.get(`${note.id}/file`)
      if (!file) problem({ ...at, class: 'projection-missing', path: note.path, detail: 'no file projection row' })
      for (const kind of ['file', 'dir_index'] as const) {
        const p = projections.get(`${note.id}/${kind}`)
        if (!p) continue
        const applied = Number(p.applied_seq) >= Number(p.target_seq)
        if (!applied && p.last_error) {
          problem({ ...at, class: 'projection-failed', path: note.path, detail: `${kind} at ${p.applied_seq} of ${p.target_seq}: ${p.last_error}` })
        } else if (!applied) {
          pending.push({ ...pendingAt, kind: 'projection', detail: `${kind} at ${p.applied_seq} of ${p.target_seq}` })
        } else if (p.index_version < PROJECTION_VERSIONS[kind]) {
          problem({ ...at, class: 'projection-outdated', path: note.path, detail: `${kind} rendered by version ${p.index_version}, current ${PROJECTION_VERSIONS[kind]}` })
        }
      }
      if (file && Number(file.applied_seq) >= seq) {
        checked.files++
        const disk = await readMaybe(join(vaultDir(note.vault_id), rel))
        const recorded = projected.get(`${note.vault_id}/${rel}`)
        if (!disk) problem({ ...at, class: 'file-missing', path: rel, detail: 'file not found on disk' })
        else {
          const content = compareNoteFile(disk.toString('utf8'), note)
          if (content.some((c) => c.problem === 'unparseable')) {
            problem({ ...at, class: 'file-unparseable', path: rel, detail: content[0]!.detail })
          } else if (content.length > 0) {
            problem({ ...at, class: 'file-differs', path: rel, detail: content.map((c) => `${c.problem}: ${c.detail}`).join('; ') })
          } else if (!recorded || recorded.owner_id !== note.id) {
            problem({ ...at, class: 'file-unrecorded', path: rel, detail: 'the projector has no record of writing this file for this note' })
          } else if (sha256(disk) !== recorded.applied_hash) {
            problem({ ...at, class: 'file-edited', path: rel, detail: 'same content as the row, but not the bytes the projector wrote' })
          }
        }
      }

      // Vectors and links (live notes).
      if (live) {
        const job = embedJobs.get(note.id)
        if (job && !job.done) pending.push({ ...pendingAt, kind: 'embedding', detail: `embedding job for seq ${seq}` })
        else if (job?.last_error) problem({ ...at, class: 'vector-failed', path: note.path, detail: `embedding for seq ${seq} failed: ${job.last_error}` })
        else if (note.no_embedding) problem({ ...at, class: 'vector-missing', path: note.path, detail: 'no embedding and no embedding job' })
        // The rows `replaceLinks` would store (`linkRows`: one per target and start line); `(no line)` rows are from before migration 0031.
        const expected = linkRows(note.id, note.body)
          .map((l) => (l.startLine === l.endLine ? `${l.targetPath}#L${l.startLine}` : `${l.targetPath}#L${l.startLine}-L${l.endLine}`))
          .sort()
        const stored = [...note.links].sort()
        if (expected.join('\n') !== stored.join('\n')) {
          const missing = expected.filter((t) => !stored.includes(t))
          const extra = stored.filter((t) => !expected.includes(t))
          problem({ ...at, class: 'links-differ', path: note.path, detail: `missing [${missing.join(', ')}], extra [${extra.join(', ')}]` })
        }
      }

      // note_crdt (ADR-003 §4/§5.4).
      const state = crdtOf.get(note.id)
      if (state) {
        checked.crdtRows++
        crdtNotes.add(note.id)
        if (state.fold_error) problem({ ...at, class: 'crdt-fold-error', path: note.path, detail: state.fold_error })
        if (state.rejected > 0) problem({ ...at, class: 'crdt-rejected-update', path: note.path, detail: `${state.rejected} rejected update(s)` })
        if (state.tail_stale) {
          problem({ ...at, class: 'crdt-tail-stale', path: note.path, detail: `${state.tail} acknowledged update(s) not folded into the row for over ${staleTailMinutes} min` })
        } else if (state.tail > 0) pending.push({ ...pendingAt, kind: 'crdt-tail', detail: `${state.tail} update(s) not folded yet` })
        else if (live && Number(state.folded_seq) < seq) {
          pending.push({ ...pendingAt, kind: 'crdt-rebase', detail: `row at seq ${seq}, CRDT state at ${state.folded_seq}: rebased at the next load or boot` })
        } else if (live && Number(state.folded_seq) === seq) {
          const detail = await snapshotDiff(client, state, note)
          if (detail) problem({ ...at, class: 'crdt-snapshot-differs', path: note.path, detail })
        }
      }
    }
  }

  // Per vault: generated indexes, orphans, conflict copies, `.crdt` bins.
  for (const row of projected.values()) {
    if (row.owner_kind !== 'dir_index') continue
    checked.files++
    const disk = await readMaybe(join(vaultDir(row.vault_id), row.path))
    const at = { vaultId: row.vault_id, noteId: null, path: row.path }
    if (!disk) problem({ ...at, class: 'file-missing', detail: 'generated index recorded but not on disk' })
    else if (sha256(disk) !== row.applied_hash) problem({ ...at, class: 'file-edited', detail: 'not the bytes the projector wrote for this index' })
  }
  for (const orphan of await orphanFiles(options.vaultId, client)) {
    problem({ class: 'file-orphan', vaultId: orphan.vaultId, noteId: null, path: orphan.path, detail: 'no note, generated index or projector record owns this file' })
  }
  for (const vault of vaults) {
    const root = vaultDir(vault.id)
    // The S2a backfill kept each file it could not parse; the projector's copy of the same bytes is that file again (#908).
    const kept = new Map<string, string[]>() // note file path -> the backfill's copies of it
    for (const file of await listFiles(root, '.migration')) {
      const rel = UNPARSEABLE_KEPT.exec(file)?.[1]
      if (rel) kept.set(rel, [...(kept.get(rel) ?? []), file])
    }
    for (const copy of await listFiles(root, '.conflicts')) {
      const name = CONFLICT_COPY.exec(copy)
      const original = name ? await sameBytes(root, copy, kept.get(`${name[1]}.md`) ?? []) : null
      if (original) {
        info.push({
          kind: 'migration-copy',
          vaultId: vault.id,
          vaultName: vault.name,
          path: copy,
          detail: `the S2a store migration could not parse this file, kept it as ${original} and wrote the note's row to the file; review, then delete both`,
        })
      } else problem({ class: 'conflict-copy', vaultId: vault.id, noteId: null, path: copy, detail: 'bytes the projector replaced; review and delete' })
    }
    for (const bin of await listFiles(root, '.crdt')) {
      if (!bin.endsWith('.bin')) continue
      const rel = bin
      const notePath = rel.slice('.crdt/'.length, -'.bin'.length)
      const noteId = livePaths.get(`${vault.id}/${notePath}`)
      if (collabMigrated) {
        // Written by older code during a rollback: the next boot merges or sets it aside (S2b roll-forward).
        pending.push({ kind: 'crdt-bin', vaultId: vault.id, vaultName: vault.name, path: rel, noteId: noteId ?? '', detail: 'merged into note_crdt at the next boot' })
        continue
      }
      // A note whose collab state is already in note_crdt: S2b never reads its bin again.
      if (noteId && crdtNotes.has(noteId)) continue
      checked.bins++
      if (!noteId) {
        problem({ class: 'crdt-bin-orphan', vaultId: vault.id, noteId: null, path: rel, detail: `no live note at ${notePath}` })
        continue
      }
      const row = ((await client.execute(sql`SELECT frontmatter, body FROM notes WHERE id = ${noteId}`)) as unknown as Array<{
        frontmatter: Record<string, unknown>
        body: string
      }>)[0]
      if (!row) continue
      const doc = new Y.Doc()
      try {
        Y.applyUpdate(doc, await readFile(join(root, rel)))
        const detail = contentDiff(docState(doc), row)
        if (detail) problem({ class: 'crdt-bin-differs', vaultId: vault.id, noteId, path: rel, detail })
      } catch (err) {
        problem({ class: 'crdt-bin-undecodable', vaultId: vault.id, noteId, path: rel, detail: err instanceof Error ? err.message : String(err) })
      } finally {
        doc.destroy()
      }
    }
  }

  // Repository files (#413): each one's blocks are those of its current content and embed key, or an extraction is on its way.
  if (!options.vaultId || options.repositoryId) {
    let afterFile = '00000000-0000-0000-0000-000000000000'
    for (;;) {
      const files = (await client.execute(sql`
        SELECT f.id, f.repository_id, r.name AS repository_name, f.path, ${hasCurrentBlocksSql()} AS current,
          j.id IS NOT NULL AS has_job, j.done_at IS NOT NULL AS done, j.last_error
        FROM repository_files f
        JOIN repositories r ON r.id = f.repository_id
        LEFT JOIN jobs j ON j.idempotency_key = ${extractionJobKeySql(sql`f.id`, sql`f.content_hash`)}
        WHERE f.id > ${afterFile} ${options.repositoryId ? sql`AND f.repository_id = ${options.repositoryId}` : sql``}
        ORDER BY f.id LIMIT ${BATCH}`)) as unknown as Array<{
        id: string
        repository_id: string
        repository_name: string
        path: string
        current: boolean
        has_job: boolean
        done: boolean
        last_error: string | null
      }>
      if (files.length === 0) break
      afterFile = files[files.length - 1]!.id
      for (const f of files) {
        checked.repositoryFiles++
        const at = { vaultId: '', vaultName: '', repositoryId: f.repository_id, repositoryName: f.repository_name, path: f.path }
        if (f.has_job && !f.done) pending.push({ ...at, noteId: f.id, kind: 'extraction', detail: 'extraction job for its current content' })
        else if (f.has_job && f.last_error) {
          problems.push({ ...at, class: 'blocks-failed', noteId: null, fileId: f.id, detail: `extraction failed: ${f.last_error}`, repairable: true })
        } else if (!f.current) {
          const detail = f.has_job ? 'its extraction finished without blocks of its current content' : 'no blocks of its current content and embed key, and no extraction job'
          problems.push({ ...at, class: 'blocks-missing', noteId: null, fileId: f.id, detail, repairable: true })
        }
      }
    }
  }

  if (repair) {
    // The job row only, as for vectors: the running server's extraction worker polls for it.
    for (const p of problems) {
      if (!p.repairable || !p.fileId) continue
      p.repaired = await affected(sql`
        INSERT INTO jobs (kind, payload, idempotency_key)
        SELECT ${EXTRACTION_JOB}, jsonb_build_object('fileId', f.id::text, 'repositoryId', f.repository_id::text),
          ${extractionJobKeySql(sql`f.id`, sql`f.content_hash`)}
        FROM repository_files f WHERE f.id = ${p.fileId}
        ${onJobConflict('finished')} RETURNING id`)
    }
    const folds = new Map<string, boolean>()
    for (const p of problems) {
      if (!p.repairable || !p.noteId) continue
      if (p.class === 'crdt-fold-error' || p.class === 'crdt-tail-stale') {
        // Boot steps 4-5 for this note, under its lock: acknowledged typing reaches the row (this is the only repair that changes a row).
        if (!folds.has(p.noteId)) folds.set(p.noteId, (await foldPendingCollab([p.noteId])).folded > 0)
        p.repaired = folds.get(p.noteId)
      } else p.repaired = await repairProblem(p)
    }
    // A generated index: re-render the dir_index projection of the notes under its directory.
    for (const p of problems) {
      if (p.repairable && !p.noteId && (p.class === 'file-missing' || p.class === 'file-edited')) {
        const dir = p.path === 'index.md' ? '' : p.path.slice(0, -'/index.md'.length)
        p.repaired = await affected(sql`
          UPDATE note_projections SET applied_seq = 0, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
          WHERE projection = 'dir_index' AND note_id IN (
            SELECT id FROM notes WHERE vault_id = ${p.vaultId} AND deleted_at IS NULL
              AND (${dir} = '' OR left(path, ${dir.length + 1}) = ${`${dir}/`}))
          RETURNING note_id`)
      }
    }
  }

  const counts: Partial<Record<DoctorClass, number>> = {}
  for (const p of problems) counts[p.class] = (counts[p.class] ?? 0) + 1
  const status = problems.length === 0 ? 'ok' : problems.every((p) => p.repairable) ? 'repairable' : 'broken'
  return { kind: 'elara-doctor', startedAt, finishedAt: new Date().toISOString(), repair, ok: problems.length === 0, status, checked, counts, problems, pending, info }
}

/** The snapshot plus its non-rejected tail, against the row it was folded into; null when equal. */
async function snapshotDiff(client: Client, state: CrdtRow, row: NoteRow): Promise<string | null> {
  const updates = (await client.execute(sql`
    SELECT update FROM note_updates WHERE note_id = ${state.note_id} AND rejected_at IS NULL AND id > ${state.snapshot_through}
    ORDER BY id`)) as unknown as Array<{ update: Uint8Array }>
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state.snapshot)
    // An update that does not apply is skipped, as the fold skips it (read-only here: the fold marks it rejected).
    for (const u of updates) {
      try {
        Y.applyUpdate(doc, u.update)
      } catch {}
    }
    return contentDiff(docState(doc), row)
  } catch (err) {
    return `does not decode: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    doc.destroy()
  }
}

/** Re-raises the derived state behind one problem (not the collab folds, see runDoctor). True when something was queued. */
async function repairProblem(p: DoctorProblem): Promise<boolean> {
  const id = p.noteId!
  switch (p.class) {
    case 'file-missing':
    case 'file-unparseable':
    case 'file-differs':
    case 'file-edited':
    case 'file-unrecorded':
    case 'projection-outdated':
      // Rendered again under the ownership rules (bytes it did not write go to .conflicts/ first).
      return affected(sql`
        UPDATE note_projections SET applied_seq = 0, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE note_id = ${id} AND ${p.class === 'projection-outdated' ? sql`projection IN ('file', 'dir_index')` : sql`projection = 'file'`}
        RETURNING note_id`)
    case 'projection-missing':
      return affected(sql`
        INSERT INTO note_projections (note_id, projection, target_seq) SELECT id, 'file', seq FROM notes WHERE id = ${id}
        ON CONFLICT (note_id, projection) DO NOTHING RETURNING note_id`)
    case 'projection-failed':
      return affected(sql`
        UPDATE note_projections SET attempts = 0, lease_until = NULL, updated_at = now()
        WHERE note_id = ${id} AND applied_seq < target_seq AND projection IN ('file', 'dir_index') RETURNING note_id`)
    case 'links-differ':
      return storeTransaction([id], async (tx) => {
        const [row] = (await tx.execute(sql`SELECT body FROM notes WHERE id = ${id} AND deleted_at IS NULL`)) as unknown as Array<{ body: string }>
        if (row) await replaceLinks(tx, id, row.body)
        return Boolean(row)
      })
    case 'vector-missing':
    case 'vector-failed':
      // The job row only: the running server's embedding worker polls for it (no model load in this process).
      // `finished`: an operator's repair runs the job again however it ended (an error, a crash, or a success that left no vector).
      return affected(sql`
        INSERT INTO jobs (kind, payload, idempotency_key)
        SELECT ${EMBEDDING_JOB}, jsonb_build_object('noteId', n.id::text, 'seq', n.seq), ${embeddingJobKeySql(sql`n.id`, sql`n.seq`)}
        FROM notes n WHERE n.id = ${id} AND n.deleted_at IS NULL
        ${onJobConflict('finished')} RETURNING id`)
    default:
      return false
  }
}

async function affected(statement: SQL): Promise<boolean> {
  return ((await db.execute(statement)) as unknown as unknown[]).length > 0
}
