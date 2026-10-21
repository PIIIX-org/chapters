/**
 * The projector (ADR-003 §7): one in-process worker that writes what is
 * derived from the note rows to disk after the write that changed them has
 * committed. It is never read back as truth.
 *
 * Work comes from two tables:
 * - `note_projections`, one row per note and projection (`file`: the note's
 *   `.md` file, or `.trash/<id>.md` while it is trashed; `dir_index`: the
 *   generated `index.md` of each directory above it). A row is pending while
 *   `applied_seq < target_seq`; the write transaction raises `target_seq`.
 *   The projector renders from the note's *current* row, so a burst of
 *   writes costs one rendering.
 * - `jobs` rows of the kinds in STORE_JOBS, for work that outlives the note
 *   row or spans notes (§5.5).
 *
 * Files are owned by path (`projected_files`: what the projector last wrote
 * at each path, and the sha256 of those bytes). Before the projector writes,
 * moves or removes a file it compares the bytes on disk with that hash, so a
 * file it did not write (a hand or `git` edit, a file truncated by a power
 * loss) is copied to `.conflicts/` first, never silently overwritten. A file
 * whose content already equals the row (written by code from before ADR-003)
 * is adopted as it is: no copy and no rewrite. File IO on one path runs under
 * an in-process lock plus a transaction-scoped Postgres advisory lock, and
 * the owner is read again under it.
 */
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.js'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes } from '../db/schema.js'
import { claimJob, completeJob, failJob, jobDrainer, type ClaimedJob } from '../jobs/durable.js'
import { recordJob } from '../monitoring/metrics.js'
import { failpoint } from '../failpoints.js'
import { atomicWrite } from './atomic-write.js'
import { withKeyLock } from './key-lock.js'
import { parseNote, serializeNote, type Frontmatter } from './okf.js'
import { resolveNotePath } from './okf/paths.js'
import { orderKeys, presentedFrontmatter, sameContent } from './frontmatter-order.js'
import type { Tx } from './store-tx.js'
import type { Actor } from './store.js'

/** Renderer versions (§4 `index_version`): bump to re-render every projection of that kind at boot. */
export const PROJECTION_VERSIONS = { file: 1, dir_index: 1 } as const

/** `jobs.kind` of the store's outbox work (§5.5). */
export const STORE_JOBS = {
  /** Regenerate the `index.md` of directories a note left (rename): `{vaultId, dirs}`. */
  dirIndex: 'store_dir_index',
  /** Release the files a purged note owned: `{vaultId, ownerId, paths}`. */
  removeFile: 'store_remove_file',
  /** Rewrite links to a renamed note in a fixed set of referrers: `{vaultId, noteId, fromPath, referrers}`. */
  renameRefactor: 'store_rename_refactor',
} as const

const CLAIM_BATCH = 32
const LEASE_MS = 60_000
const BACKOFF_MAX_MS = 60_000

function vaultRoot(vaultId: string): string {
  // Not store.ts's vaultDir: store.ts imports this module.
  return join(config.dataDir, 'vaults', vaultId)
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readMaybe(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** A path the projector found holding bytes it did not write; reported once per copy. */
export interface ConflictCopy {
  vaultId: string
  path: string
  copy: string
}

/** Conflict copies made since boot (monitoring and tests read the count). */
export const conflictCopies: ConflictCopy[] = []

async function conflictCopy(vaultId: string, rel: string, bytes: Buffer): Promise<void> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '')
  const copy = `.conflicts/${rel.replace(/\.md$/, '')}.${stamp}.md`
  await atomicWrite(join(vaultRoot(vaultId), copy), bytes)
  conflictCopies.push({ vaultId, path: rel, copy })
  console.warn(`[projector] ${vaultId}/${rel} held bytes the projector did not write: copied to ${copy}`)
  recordJob('projection', { error: { name: 'ConflictCopy', message: `${rel} -> ${copy}` }, repeat: false }, vaultId)
}

/** Takes the per-path lock of `rel` in `vaultId`: in-process, then a transaction-scoped advisory lock (§7 step 3). */
async function withPathLock<T>(vaultId: string, rel: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withKeyLock(`file:${vaultId}/${rel}`, () =>
    db.transaction(async (tx) => {
      const [lock] = (await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`${vaultId}/${rel}`}, 1)) AS ok`,
      )) as unknown as Array<{ ok: boolean }>
      if (!lock?.ok) throw new Error(`path ${rel} is being projected by another process`)
      return fn(tx)
    }),
  )
}

/**
 * Whether the vault still exists (a trashed vault keeps its files, so a
 * restore of it finds them). FOR SHARE: a vault purge waits for this
 * transaction, then removes the directory after it, so the projector never
 * recreates a purged vault's directory.
 */
async function vaultLive(tx: Tx, vaultId: string): Promise<boolean> {
  const rows = await tx.execute(sql`SELECT 1 FROM vaults WHERE id = ${vaultId} FOR SHARE`)
  return (rows as unknown as unknown[]).length > 0
}

interface ProjectedFile {
  owner_kind: string
  owner_id: string | null
  applied_hash: string
}

async function projectedFile(tx: Tx, vaultId: string, rel: string): Promise<ProjectedFile | null> {
  const [row] = (await tx.execute(
    sql`SELECT owner_kind, owner_id, applied_hash FROM projected_files WHERE vault_id = ${vaultId} AND path = ${rel}`,
  )) as unknown as ProjectedFile[]
  return row ?? null
}

async function recordProjected(
  tx: Tx,
  vaultId: string,
  rel: string,
  owner: { kind: string; id: string | null; seq: number | null },
  hash: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO projected_files (vault_id, path, owner_kind, owner_id, applied_hash, applied_seq)
    VALUES (${vaultId}, ${rel}, ${owner.kind}, ${owner.id}, ${hash}, ${owner.seq})
    ON CONFLICT (vault_id, path) DO UPDATE SET owner_kind = EXCLUDED.owner_kind, owner_id = EXCLUDED.owner_id,
      applied_hash = EXCLUDED.applied_hash, applied_seq = EXCLUDED.applied_seq, written_at = now()`)
}

/** What the projector did at a path. */
type WriteOutcome = 'written' | 'unchanged' | 'adopted' | 'conflict'

/**
 * Writes `bytes` at `rel` under the ownership rules (§7): absent → write;
 * equal → record; the projector's own last bytes → overwrite; content equal
 * to the owner's (`adopts`) → adopt; anything else → conflict copy, then write.
 */
async function writeOwned(
  tx: Tx,
  vaultId: string,
  rel: string,
  bytes: string,
  owner: { kind: string; id: string | null; seq: number | null },
  adopts: (disk: string) => boolean,
): Promise<WriteOutcome> {
  const file = join(vaultRoot(vaultId), rel)
  const disk = await readMaybe(file)
  const known = await projectedFile(tx, vaultId, rel)
  let outcome: WriteOutcome = 'written'
  if (disk && disk.equals(Buffer.from(bytes, 'utf8'))) outcome = 'unchanged'
  else if (disk && !(known && sha256(disk) === known.applied_hash)) {
    if (adopts(disk.toString('utf8'))) outcome = 'adopted'
    else {
      await conflictCopy(vaultId, rel, disk)
      outcome = 'conflict'
    }
  }
  if (outcome === 'written' || outcome === 'conflict') {
    await atomicWrite(file, bytes, { beforeRename: () => failpoint('projector.after-tmp-before-rename') })
    failpoint('projector.after-rename-before-mark')
  }
  await recordProjected(tx, vaultId, rel, owner, outcome === 'adopted' ? sha256(disk!) : sha256(bytes))
  return outcome
}

/**
 * Releases `rel` (§7 "release P"): only when `ownerId` owns it in
 * `projected_files` and no live owner has it now. The projector's own bytes
 * are unlinked; anything else is copied to `.conflicts/` first.
 */
async function releaseOwned(tx: Tx, vaultId: string, rel: string, ownerId: string | null, liveOwner: boolean): Promise<void> {
  const known = await projectedFile(tx, vaultId, rel)
  if (!known || known.owner_id !== ownerId || liveOwner) return
  const file = join(vaultRoot(vaultId), rel)
  const disk = await readMaybe(file)
  if (disk && sha256(disk) !== known.applied_hash) await conflictCopy(vaultId, rel, disk)
  if (disk) await rm(file, { force: true })
  await tx.execute(sql`DELETE FROM projected_files WHERE vault_id = ${vaultId} AND path = ${rel}`)
}

/** Whether a live note other than `exceptId` owns `rel` (`<path>.md`), or a trashed note owns `.trash/<id>.md`. */
async function pathHasLiveOwner(tx: Tx, vaultId: string, rel: string, exceptId: string | null): Promise<boolean> {
  const trash = /^\.trash\/([0-9a-f-]{36})\.md$/.exec(rel)
  const rows = trash
    ? await tx.execute(sql`SELECT 1 FROM notes WHERE id = ${trash[1]} AND deleted_at IS NOT NULL`)
    : await tx.execute(sql`
        SELECT 1 FROM notes WHERE vault_id = ${vaultId} AND path = ${rel.replace(/\.md$/, '')} AND deleted_at IS NULL
          AND id IS DISTINCT FROM ${exceptId}::uuid`)
  return (rows as unknown as unknown[]).length > 0
}

interface NoteForFile {
  id: string
  vault_id: string
  path: string
  deleted_at: string | null
  seq: string
  frontmatter: Record<string, unknown>
  frontmatter_src: Record<string, unknown> | null
  body: string
}

async function noteForFile(tx: Tx | typeof db, noteId: string): Promise<NoteForFile | null> {
  const [row] = (await tx.execute(sql`
    SELECT id, vault_id, path, deleted_at, seq, frontmatter, frontmatter_src, body FROM notes WHERE id = ${noteId}`)) as unknown as NoteForFile[]
  return row ?? null
}

/** The vault-relative file of a note: `<path>.md`, or `.trash/<id>.md` while trashed. */
export function noteFileRel(note: { id: string; path: string; deletedAt: unknown }): string {
  return note.deletedAt ? `.trash/${note.id}.md` : `${note.path}.md`
}

/** The note rendered as its file: `serializeNote` with the `frontmatter_src` key order. */
export function renderNoteFile(note: { frontmatter: unknown; frontmatterSrc: unknown; body: string }): string {
  // Every stored row passed validateNote, so its frontmatter has `type`.
  const frontmatter = presentedFrontmatter(note.frontmatter, note.frontmatterSrc) as Frontmatter
  return serializeNote({ frontmatter, body: note.body })
}

/**
 * The adopt rule (§7): a file that parses to the row's content (frontmatter
 * key by key with deep equality, body exactly). Returns the file's key order
 * as `frontmatter_src`, or null when the file does not adopt.
 */
function adoption(disk: string, note: NoteForFile): Record<string, unknown> | null {
  try {
    const parsed = parseNote(disk)
    if (parsed.body !== note.body || !sameContent(parsed.frontmatter, note.frontmatter)) return null
    return orderKeys(parsed.frontmatter, note.frontmatter)
  } catch {
    return null
  }
}

/**
 * Projects one note's `file`: releases the paths it no longer owns, writes
 * its current path. Returns the seq rendered; 'gone' when there is nothing
 * to write (the note was purged, or its vault is deleted); 'moved' when the
 * note moved again after it was read (the next claim renders it).
 */
async function projectFile(noteId: string): Promise<number | 'gone' | 'moved'> {
  const seen = await noteForFile(db, noteId)
  if (!seen) return 'gone'
  const rel = noteFileRel({ id: seen.id, path: seen.path, deletedAt: seen.deleted_at })
  const stale = (await db.execute(sql`
    SELECT path FROM projected_files WHERE owner_id = ${noteId} AND vault_id = ${seen.vault_id} AND path <> ${rel}`)) as unknown as Array<{
    path: string
  }>
  for (const { path } of stale) {
    await withPathLock(seen.vault_id, path, async (tx) => {
      if (!(await vaultLive(tx, seen.vault_id))) return
      await releaseOwned(tx, seen.vault_id, path, noteId, await pathHasLiveOwner(tx, seen.vault_id, path, noteId))
    })
  }
  return withPathLock(seen.vault_id, rel, async (tx) => {
    if (!(await vaultLive(tx, seen.vault_id))) return 'gone' as const
    // The owner is read again under the path lock: the decision made before it is not trusted.
    const note = await noteForFile(tx, noteId)
    if (!note) return 'gone' as const
    if (noteFileRel({ id: note.id, path: note.path, deletedAt: note.deleted_at }) !== rel) return 'moved' as const
    const seq = Number(note.seq)
    let order: Record<string, unknown> | null = null
    const outcome = await writeOwned(
      tx,
      note.vault_id,
      rel,
      renderNoteFile({ frontmatter: note.frontmatter, frontmatterSrc: note.frontmatter_src, body: note.body }),
      { kind: note.deleted_at ? 'trash' : 'note', id: note.id, seq },
      (disk) => (order = adoption(disk, note)) !== null,
    )
    if (outcome === 'adopted' && order) {
      // The file keeps its bytes: its key order becomes the note's (§7 adopt).
      await tx.execute(sql`UPDATE notes SET frontmatter_src = ${JSON.stringify(order)}::json WHERE id = ${note.id} AND seq = ${seq}`)
    }
    await markApplied(tx, note.id, 'file', seq)
    return seq
  })
}

async function markApplied(tx: Tx | typeof db, noteId: string, projection: string, seq: number): Promise<void> {
  const version = projection === 'file' ? PROJECTION_VERSIONS.file : PROJECTION_VERSIONS.dir_index
  await tx.execute(sql`
    UPDATE note_projections SET applied_seq = GREATEST(applied_seq, ${seq}), index_version = ${version},
      lease_until = NULL, attempts = 0, last_error = NULL, updated_at = now()
    WHERE note_id = ${noteId} AND projection = ${projection}`)
}

interface IndexRow {
  path: string
  type: string
  frontmatter: Record<string, unknown>
}

/**
 * The generated `index.md` of `dir` (OKF v0.2 progressive disclosure: its
 * subdirectories and its notes), from the vault's live rows; null when the
 * directory holds nothing, or when `<dir>/index` is a live note (#384: that
 * file is the user's note). Also used by `browse_vault` (§6), so it never
 * reads the file.
 */
export function renderDirIndex(rows: IndexRow[], dir: string): string | null {
  if (rows.some((note) => note.path === `${dir}/index`)) return null
  const prefix = `${dir}/`
  const subdirCounts = new Map<string, number>()
  const childNotes: Array<{ path: string; baseName: string; type: string; frontmatter: Record<string, unknown> }> = []
  for (const note of rows) {
    if (note.path === 'index' || note.path.endsWith('/index')) continue
    if (!note.path.startsWith(prefix)) continue
    const remainder = note.path.slice(prefix.length)
    if (!remainder) continue
    const slashIndex = remainder.indexOf('/')
    if (slashIndex === -1) {
      childNotes.push({ path: note.path, baseName: remainder, type: note.type, frontmatter: note.frontmatter ?? {} })
    } else {
      const subdir = remainder.slice(0, slashIndex)
      subdirCounts.set(subdir, (subdirCounts.get(subdir) ?? 0) + 1)
    }
  }
  if (subdirCounts.size === 0 && childNotes.length === 0) return null
  const sections: string[] = []
  if (subdirCounts.size > 0) {
    const sortedSubdirs = [...subdirCounts.entries()].sort(([a], [b]) => a.localeCompare(b))
    const lines = [
      '## Subsystems & Architectural Domains',
      '',
      '| Subsystem / Domain | Active Concepts | Index |',
      '| :--- | :--- | :--- |',
    ]
    for (const [subdir, count] of sortedSubdirs) {
      lines.push(`| **${subdir}** | ${count} notes | [[${dir}/${subdir}/index|View Domain]] |`)
    }
    sections.push(lines.join('\n'))
  }
  if (childNotes.length > 0) {
    childNotes.sort((a, b) => a.path.localeCompare(b.path))
    const lines = ['## Concepts & Artifacts', '', '| Concept | Type | Status | Description |', '| :--- | :--- | :--- | :--- |']
    for (const child of childNotes) {
      const fm = child.frontmatter
      const type = typeof fm.type === 'string' && fm.type ? String(fm.type) : child.type
      const status = fm.status !== undefined && fm.status !== null ? String(fm.status) : ''
      const description = typeof fm.description === 'string' ? fm.description : ''
      const link =
        typeof fm.title === 'string' && fm.title.trim() && fm.title.trim() !== child.baseName
          ? `[[${child.path}|${fm.title.trim()}]]`
          : `[[${child.path}]]`
      lines.push(`| ${link} | \`${type}\` | ${status} | ${description} |`)
    }
    sections.push(lines.join('\n'))
  }
  return `${sections.join('\n\n')}\n`
}

/** The live rows `renderDirIndex` lists. */
export async function indexRows(vaultId: string): Promise<IndexRow[]> {
  return db
    .select({ path: notes.path, type: notes.type, frontmatter: sql<Record<string, unknown>>`${notes.frontmatter}` })
    .from(notes)
    .where(and(eq(notes.vaultId, vaultId), isNull(notes.deletedAt)))
}

/** A generated index.md written by code from before ADR-003 has no frontmatter fence: it is not a note file. */
function looksGenerated(disk: string): boolean {
  try {
    parseNote(disk)
    return false
  } catch {
    return true
  }
}

/**
 * Regenerates the `index.md` of each directory in `dirs` from the current
 * rows, under the ownership rules (owner kind `dir_index`). A directory whose
 * `<dir>/index` is a live note is left to that note's file projection.
 */
export async function projectDirIndices(vaultId: string, dirs: Iterable<string>): Promise<void> {
  const unique = [...new Set([...dirs].filter(Boolean))].sort()
  if (unique.length === 0) return
  for (const dir of unique) {
    const rel = `${dir}/index.md`
    await withPathLock(vaultId, rel, async (tx) => {
      if (!(await vaultLive(tx, vaultId))) return
      // Rows read again under the lock: a create that committed meanwhile is listed (#779).
      const current = await indexRows(vaultId)
      if (current.some((note) => note.path === `${dir}/index`)) return
      const content = renderDirIndex(current, dir)
      if (content === null) {
        const known = await projectedFile(tx, vaultId, rel)
        if (known) await releaseOwned(tx, vaultId, rel, known.owner_id, false)
        else {
          const disk = await readMaybe(join(vaultRoot(vaultId), rel))
          // Old code's own rendering of an emptied directory: removed as it would have.
          if (disk && looksGenerated(disk.toString('utf8'))) await rm(join(vaultRoot(vaultId), rel), { force: true })
        }
        return
      }
      await writeOwned(tx, vaultId, rel, content, { kind: 'dir_index', id: null, seq: null }, looksGenerated)
    })
  }
}

interface ClaimedProjection {
  note_id: string
  projection: 'file' | 'dir_index'
  target_seq: string
  attempts: number
}

async function claimProjections(): Promise<ClaimedProjection[]> {
  return (await db.execute(sql`
    UPDATE note_projections p SET lease_until = now() + ${LEASE_MS} * interval '1 millisecond', attempts = p.attempts + 1
    FROM (
      SELECT note_id, projection FROM note_projections
      WHERE applied_seq < target_seq AND projection IN ('file', 'dir_index') AND (lease_until IS NULL OR lease_until < now())
      ORDER BY updated_at LIMIT ${CLAIM_BATCH}
      FOR UPDATE SKIP LOCKED
    ) c
    WHERE p.note_id = c.note_id AND p.projection = c.projection
    RETURNING p.note_id, p.projection, p.target_seq, p.attempts`)) as unknown as ClaimedProjection[]
}

async function failProjection(claim: ClaimedProjection, err: unknown): Promise<void> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  const backoff = Math.min(1000 * 2 ** Math.max(0, claim.attempts - 1), BACKOFF_MAX_MS)
  await db.execute(sql`
    UPDATE note_projections SET last_error = ${message.slice(0, 500)},
      lease_until = now() + ${backoff} * interval '1 millisecond', updated_at = now()
    WHERE note_id = ${claim.note_id} AND projection = ${claim.projection}`)
  console.error(`[projector] ${claim.projection} of note ${claim.note_id} failed (attempt ${claim.attempts}):`, err)
  recordJob('projection', { error: err, repeat: claim.attempts > 1 }, claim.note_id)
}

/** Runs one claimed batch: files one by one, directory indexes coalesced per vault. */
async function runProjections(claims: ClaimedProjection[]): Promise<void> {
  const dirClaims = claims.filter((c) => c.projection === 'dir_index')
  for (const claim of claims) {
    if (claim.projection !== 'file') continue
    try {
      const outcome = await projectFile(claim.note_id)
      if (outcome === 'gone') await markApplied(db, claim.note_id, 'file', Number(claim.target_seq))
      // Moved again since it was read: the next claim renders the new path.
      if (outcome === 'moved') {
        await db.execute(sql`UPDATE note_projections SET lease_until = NULL WHERE note_id = ${claim.note_id} AND projection = 'file'`)
      }
      recordJob('projection', 'ok', claim.note_id)
    } catch (err) {
      await failProjection(claim, err)
    }
  }
  if (dirClaims.length === 0) return
  const byVault = new Map<string, { dirs: Set<string>; claims: ClaimedProjection[] }>()
  for (const claim of dirClaims) {
    const [note] = await db.select({ vaultId: notes.vaultId, path: notes.path }).from(notes).where(eq(notes.id, claim.note_id))
    if (!note) continue
    const entry = byVault.get(note.vaultId) ?? { dirs: new Set<string>(), claims: [] }
    for (const dir of resolveNotePath(note.path).ancestorDirectories) entry.dirs.add(dir)
    entry.claims.push(claim)
    byVault.set(note.vaultId, entry)
  }
  for (const [vaultId, { dirs, claims: vaultClaims }] of byVault) {
    try {
      await projectDirIndices(vaultId, dirs)
      for (const claim of vaultClaims) await markApplied(db, claim.note_id, 'dir_index', Number(claim.target_seq))
    } catch (err) {
      for (const claim of vaultClaims) await failProjection(claim, err)
    }
  }
}

/** Runner of a rename's referrer refactor, registered by store.ts (which imports this module). */
let renameRefactorRunner: ((payload: RenameRefactorPayload) => Promise<void>) | null = null

export interface RenameRefactorPayload {
  vaultId: string
  noteId: string
  fromPath: string
  referrers: string[]
  /** Who renamed the note: the referrer rewrites are credited to them (#403). */
  actor?: Actor
}

export function registerRenameRefactor(runner: (payload: RenameRefactorPayload) => Promise<void>): void {
  renameRefactorRunner = runner
}

/** Releases every file a purged note owned, and its trash file even if no rendering of it was recorded. */
async function removeFiles(payload: { vaultId: string; ownerId: string; paths: string[] }): Promise<void> {
  const owned = (await db.execute(sql`
    SELECT path FROM projected_files WHERE owner_id = ${payload.ownerId} AND vault_id = ${payload.vaultId}`)) as unknown as Array<{
    path: string
  }>
  for (const rel of new Set([...owned.map((o) => o.path), ...payload.paths])) {
    await withPathLock(payload.vaultId, rel, async (tx) => {
      if (await pathHasLiveOwner(tx, payload.vaultId, rel, payload.ownerId)) return
      const known = await projectedFile(tx, payload.vaultId, rel)
      if (known) await releaseOwned(tx, payload.vaultId, rel, payload.ownerId, false)
      else if (rel === `.trash/${payload.ownerId}.md`) await rm(join(vaultRoot(payload.vaultId), rel), { force: true })
    })
  }
}

async function runJob<P>(kind: string, run: (payload: P) => Promise<void>): Promise<boolean> {
  const job: ClaimedJob<P> | null = await claimJob<P>(kind)
  if (!job) return false
  try {
    await run(job.payload)
    await completeJob(job.id)
  } catch (err) {
    await failJob(job, err, 'projection', kind)
  }
  return true
}

async function runStoreJobs(): Promise<boolean> {
  let ran = false
  while (await runJob<{ vaultId: string; dirs: string[] }>(STORE_JOBS.dirIndex, (p) => projectDirIndices(p.vaultId, p.dirs))) ran = true
  while (await runJob(STORE_JOBS.removeFile, removeFiles)) ran = true
  while (
    await runJob<RenameRefactorPayload>(STORE_JOBS.renameRefactor, async (p) => {
      if (!renameRefactorRunner) throw new Error('rename refactor runner not registered')
      await renameRefactorRunner(p)
    })
  )
    ran = true
  return ran
}

async function drainOnce(): Promise<void> {
  for (;;) {
    const claims = await claimProjections()
    if (claims.length > 0) await runProjections(claims)
    const ranJobs = await runStoreJobs()
    if (claims.length === 0 && !ranJobs) return
  }
}

const projector = jobDrainer('projection', drainOnce)

/** Wakes the projector after a commit (never blocks the caller). */
export function wakeProjector(): void {
  projector.kick()
}

/**
 * Runs the projector until nothing claimable is pending: server tests (and
 * their teardown, so CI's `check-notes --fail-on-pending` finds every file
 * written) and the stopped-server export.
 */
export async function flushProjections(): Promise<void> {
  projector.kick()
  await projector.flush()
}

/** Pending projection rows (`applied_seq < target_seq`), optionally for one vault. */
export async function pendingProjections(vaultId?: string): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM note_projections p JOIN notes n ON n.id = p.note_id
    WHERE p.applied_seq < p.target_seq AND p.projection IN ('file', 'dir_index')
      ${vaultId ? sql`AND n.vault_id = ${vaultId}` : sql``}`)) as unknown as Array<{ n: number }>
  return row?.n ?? 0
}
