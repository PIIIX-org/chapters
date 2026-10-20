/**
 * ADR-003 §8 rehearsal: the read-only half of `migrate-store`. Walks every
 * note (live and trashed) by id in batches of 100 inside one
 * `REPEATABLE READ READ ONLY` transaction, reads its `.md` file and its
 * `.crdt` bin, and classifies what the S2a and S2b backfills would do, without
 * doing it. It reads only columns that exist before migration 0021, so it runs
 * on a production copy that has not been upgraded. It writes nothing: the
 * caller (the CLI) decides where the report goes.
 *
 * The backfill itself ships in S2a; this module only predicts it.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { TransactionSql } from 'postgres'
import * as Y from 'yjs'
import { config } from '../config.js'
import { sql } from '../db/client.js'
import { parseNote, serializeNote, type OkfNote } from './okf.js'

const BATCH = 100

export type FileClass = 'consistent' | 'missing' | 'unparseable' | 'differs'
export type RevisionClass = 'consistent' | 'gap' | 'none'
/** S2b (§8 step 4a): a bin is attached only when its text equals the row, the file or a revision. */
export type CrdtClass =
  | 'matches-row'
  | 'matches-file'
  | 'matches-revision'
  | 'mismatch'
  | 'missing'
  | 'undecodable'
/** §8 step 2f, the `file` projection after the backfill. */
export type ProjectionClass = 'applied' | 'adopted' | 'create' | 'rewrite'

export interface NoteEntry {
  noteId: string
  vaultId: string
  path: string
  trashed: boolean
  file: FileClass
  /** Whether the file's bytes equal `serializeNote` of its parsed content; null when it did not parse. */
  serializeNoteForm: boolean | null
  revision: RevisionClass
  /** null for trashed notes: the S2b backfill runs per live note. */
  crdt: CrdtClass | null
  projection: ProjectionClass
  embedding: 'applied' | 'pending'
  detail?: string
}

/** Q5: file ≠ row, the file wins and the row's text is kept as a revision. */
export interface Conflict {
  noteId: string
  vaultId: string
  path: string
  trashed: boolean
  rowUpdatedAt: string
  fileMtime: string
  newer: 'row' | 'file' | 'same'
  /** sha256 of the row rendered with `serializeNote` (jsonb key order). */
  rowHash: string
  /** sha256 of the file's bytes. */
  fileHash: string
  differingFrontmatterKeys: string[]
  bodyDiffers: boolean
  resolution: 'file-wins'
}

export interface StoreMigrationReport {
  kind: 'adr-003-store-migration-dry-run'
  generatedAt: string
  dataDir: string
  vaultId: string | null
  database: {
    readOnlyTransaction: boolean
    isolation: string
    /** Migration 0021 applied (dry runs normally run before it). */
    schema0021Applied: boolean
    storeMigratedAt: string | null
    collabMigratedAt: string | null
  }
  counts: {
    notes: number
    liveNotes: number
    trashedNotes: number
    file: Record<FileClass, number>
    notSerializeNoteForm: number
    revision: Record<RevisionClass, number>
    crdt: Record<CrdtClass, number>
    projection: Record<ProjectionClass, number>
    embeddingPending: number
    /** `.md` files with no live note at their path (not generated `index.md` files). */
    filesWithoutRow: number
    /** Generated directory `index.md` files (owned by the `dir_index` projection). */
    dirIndexFiles: number
    trashFilesWithoutRow: number
    binsWithoutNote: number
    tempFiles: number
    conflicts: number
    filesThatChangeBytes: number
  }
  sizes: {
    bodyBytes: number
    crdtBytes: number
    noteRevisionsRows: number
    noteRevisionsBytes: number
  }
  timingsMs: { database: number; files: number; crdt: number; diskScan: number; total: number }
  estimate: {
    method: string
    notes: number
    filesThatChangeBytes: number
    noteRevisionsBytes: number
    measuredMsPerNote: number
  }
  conflicts: Conflict[]
  filesThatChangeBytes: Array<{ noteId: string; vaultId: string; path: string; reason: 'create' | 'rewrite' }>
  missingRows: {
    files: Array<{ vaultId: string; path: string }>
    trashFiles: Array<{ vaultId: string; path: string }>
    bins: Array<{ vaultId: string; path: string }>
  }
  notes: NoteEntry[]
}

interface NoteRowLite {
  id: string
  vault_id: string
  path: string
  frontmatter: Record<string, unknown>
  body: string
  /** Timestamps arrive as text: drizzle replaces the driver's date parsers on this client. */
  deleted_at: string | null
  updated_at: string
  has_embedding: boolean
}

function differingKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !isDeepStrictEqual(a[k], b[k])).sort()
}

async function readMaybe(file: string): Promise<{ bytes: Buffer; mtime: Date } | null> {
  try {
    const [bytes, info] = await Promise.all([readFile(file), stat(file)])
    return { bytes, mtime: info.mtime }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Lists files under `dir` (relative, `/`-separated), or [] when it does not exist. */
async function walk(dir: string, skip: (rel: string, isDir: boolean) => boolean = () => false): Promise<string[]> {
  const out: string[] = []
  async function visit(abs: string): Promise<void> {
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      const child = join(abs, entry.name)
      const rel = relative(dir, child).split(sep).join('/')
      if (skip(rel, entry.isDirectory())) continue
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) out.push(rel)
    }
  }
  await visit(dir)
  return out
}

const TEMP_FILE = /\.\d+\.[0-9a-f]{12}\.tmp$/

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>

export async function planStoreMigration(options: { vaultId?: string } = {}): Promise<StoreMigrationReport> {
  const started = performance.now()
  const timings = { database: 0, files: 0, crdt: 0, diskScan: 0, total: 0 }
  const vaultsDir = join(config.dataDir, 'vaults')
  const vaultFilter = options.vaultId ?? null
  const report: StoreMigrationReport = {
    kind: 'adr-003-store-migration-dry-run',
    generatedAt: new Date().toISOString(),
    dataDir: config.dataDir,
    vaultId: vaultFilter,
    database: {
      readOnlyTransaction: false,
      isolation: '',
      schema0021Applied: false,
      storeMigratedAt: null,
      collabMigratedAt: null,
    },
    counts: {
      notes: 0,
      liveNotes: 0,
      trashedNotes: 0,
      file: zero(['consistent', 'missing', 'unparseable', 'differs'] as const),
      notSerializeNoteForm: 0,
      revision: zero(['consistent', 'gap', 'none'] as const),
      crdt: zero(['matches-row', 'matches-file', 'matches-revision', 'mismatch', 'missing', 'undecodable'] as const),
      projection: zero(['applied', 'adopted', 'create', 'rewrite'] as const),
      embeddingPending: 0,
      filesWithoutRow: 0,
      dirIndexFiles: 0,
      trashFilesWithoutRow: 0,
      binsWithoutNote: 0,
      tempFiles: 0,
      conflicts: 0,
      filesThatChangeBytes: 0,
    },
    sizes: { bodyBytes: 0, crdtBytes: 0, noteRevisionsRows: 0, noteRevisionsBytes: 0 },
    timingsMs: timings,
    estimate: { method: '', notes: 0, filesThatChangeBytes: 0, noteRevisionsBytes: 0, measuredMsPerNote: 0 },
    conflicts: [],
    filesThatChangeBytes: [],
    missingRows: { files: [], trashFiles: [], bins: [] },
    notes: [],
  }
  /** vault id -> live note paths / trashed note ids, for the disk scan. */
  const livePaths = new Map<string, Set<string>>()
  const trashedIds = new Map<string, Set<string>>()

  // One snapshot for the whole walk; READ ONLY makes Postgres refuse any write.
  await sql.begin('isolation level repeatable read read only', async (tx) => {
    const t0 = performance.now()
    const [mode] = await tx<Array<{ ro: string; iso: string }>>`
      select current_setting('transaction_read_only') as ro, current_setting('transaction_isolation') as iso`
    report.database.readOnlyTransaction = mode!.ro === 'on'
    report.database.isolation = mode!.iso
    const [applied] = await tx<Array<{ applied: boolean }>>`
      select to_regclass('public.note_projections') is not null as applied`
    report.database.schema0021Applied = applied!.applied
    if (applied!.applied) {
      const [markers] = await tx<Array<{ store: string | null; collab: string | null }>>`
        select store_migrated_at as store, collab_migrated_at as collab from instance_state limit 1`
      report.database.storeMigratedAt = markers?.store ? new Date(markers.store).toISOString() : null
      report.database.collabMigratedAt = markers?.collab ? new Date(markers.collab).toISOString() : null
    }
    const [revSize] = await tx<Array<{ rows: string; bytes: string }>>`
      select (select count(*) from note_revisions) as rows,
             pg_total_relation_size('note_revisions') as bytes`
    report.sizes.noteRevisionsRows = Number(revSize!.rows)
    report.sizes.noteRevisionsBytes = Number(revSize!.bytes)
    timings.database += performance.now() - t0

    let after = '00000000-0000-0000-0000-000000000000'
    for (;;) {
      const t1 = performance.now()
      const rows = await tx<NoteRowLite[]>`
        select id, vault_id, path, frontmatter, body, deleted_at, updated_at,
               embedding is not null as has_embedding
        from notes
        where id > ${after} ${vaultFilter === null ? tx`` : tx`and vault_id = ${vaultFilter}`}
        order by id limit ${BATCH}`
      if (rows.length === 0) {
        timings.database += performance.now() - t1
        break
      }
      after = rows[rows.length - 1]!.id
      const latest = new Map<string, { frontmatter: Record<string, unknown>; body: string }>()
      for (const r of await tx<Array<{ note_id: string; frontmatter: Record<string, unknown>; body: string }>>`
        select distinct on (note_id) note_id, frontmatter, body from note_revisions
        where note_id in ${tx(rows.map((r) => r.id))}
        order by note_id, created_at desc, id desc`) {
        latest.set(r.note_id, { frontmatter: r.frontmatter, body: r.body })
      }
      timings.database += performance.now() - t1
      for (const row of rows) {
        await classifyNote(tx, row, latest.get(row.id), report, timings, vaultsDir)
        const trashed = row.deleted_at !== null
        const map = trashed ? trashedIds : livePaths
        if (!map.has(row.vault_id)) map.set(row.vault_id, new Set())
        map.get(row.vault_id)!.add(trashed ? row.id : row.path)
      }
    }
  })

  // Missing rows: files on disk that no note owns (§7 ownership: live note at
  // the path, trashed note by id, generated index.md for directories).
  const t2 = performance.now()
  // Only directories are vaults: a stray file under vaults/ (.DS_Store) is not one.
  const dirs =
    vaultFilter === null
      ? (await readdir(vaultsDir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return []
          throw err
        }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [vaultFilter]
  for (const vaultId of dirs) {
    const root = join(vaultsDir, vaultId)
    const live = livePaths.get(vaultId) ?? new Set<string>()
    const trashed = trashedIds.get(vaultId) ?? new Set<string>()
    const files = await walk(root, (rel, isDir) => isDir && rel === 'assets')
    for (const rel of files) {
      if (TEMP_FILE.test(rel)) {
        report.counts.tempFiles++
        continue
      }
      if (rel.startsWith('.trash/')) {
        const id = rel.slice('.trash/'.length).replace(/\.md$/, '')
        if (rel.endsWith('.md') && !trashed.has(id)) report.missingRows.trashFiles.push({ vaultId, path: rel })
      } else if (rel.startsWith('.crdt/')) {
        const path = rel.slice('.crdt/'.length).replace(/\.bin$/, '')
        if (rel.endsWith('.bin') && !live.has(path)) report.missingRows.bins.push({ vaultId, path: rel })
      } else if (rel.endsWith('.md') && !rel.split('/').some((seg) => seg.startsWith('.'))) {
        const path = rel.slice(0, -'.md'.length)
        if (live.has(path)) continue
        if (path === 'index' || path.endsWith('/index')) report.counts.dirIndexFiles++
        else report.missingRows.files.push({ vaultId, path: rel })
      }
    }
  }
  timings.diskScan = performance.now() - t2

  const c = report.counts
  c.filesWithoutRow = report.missingRows.files.length
  c.trashFilesWithoutRow = report.missingRows.trashFiles.length
  c.binsWithoutNote = report.missingRows.bins.length
  c.conflicts = report.conflicts.length
  c.filesThatChangeBytes = report.filesThatChangeBytes.length
  timings.total = performance.now() - started
  for (const k of Object.keys(timings) as Array<keyof typeof timings>) timings[k] = Math.round(timings[k])
  report.estimate = {
    method:
      'T ≈ T_index(note_revisions bytes) + N × t_note + F × t_write (ADR-003 §8). measuredMsPerNote is this ' +
      'read-only pass per note (file read, YAML parse, Yjs decode); the backfill adds one commit per note and ' +
      'the 0021 index build on note_revisions. Production estimate = rehearsal wall time × host ratio.',
    notes: c.notes,
    filesThatChangeBytes: c.filesThatChangeBytes,
    noteRevisionsBytes: report.sizes.noteRevisionsBytes,
    measuredMsPerNote: c.notes === 0 ? 0 : Number((timings.total / c.notes).toFixed(3)),
  }
  return report
}

async function classifyNote(
  tx: TransactionSql,
  row: NoteRowLite,
  latest: { frontmatter: Record<string, unknown>; body: string } | undefined,
  report: StoreMigrationReport,
  timings: StoreMigrationReport['timingsMs'],
  vaultsDir: string,
): Promise<void> {
  const trashed = row.deleted_at !== null
  const c = report.counts
  c.notes++
  if (trashed) c.trashedNotes++
  else c.liveNotes++
  report.sizes.bodyBytes += Buffer.byteLength(row.body)

  // a/b. file
  const t0 = performance.now()
  const relPath = trashed ? `.trash/${row.id}.md` : `${row.path}.md`
  const file = await readMaybe(join(vaultsDir, row.vault_id, relPath))
  let fileClass: FileClass
  let parsed: OkfNote | null = null
  let serializeNoteForm: boolean | null = null
  let detail: string | undefined
  if (!file) fileClass = 'missing'
  else {
    try {
      parsed = parseNote(file.bytes.toString('utf8'))
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err)
    }
    if (!parsed) fileClass = 'unparseable'
    else {
      serializeNoteForm = serializeNote(parsed) === file.bytes.toString('utf8')
      const keys = differingKeys(parsed.frontmatter, row.frontmatter)
      const bodyDiffers = parsed.body !== row.body
      fileClass = keys.length === 0 && !bodyDiffers ? 'consistent' : 'differs'
      if (fileClass === 'differs') {
        const rowUpdated = new Date(row.updated_at).getTime()
        const mtime = file.mtime.getTime()
        report.conflicts.push({
          noteId: row.id,
          vaultId: row.vault_id,
          path: relPath,
          trashed,
          rowUpdatedAt: new Date(row.updated_at).toISOString(),
          fileMtime: file.mtime.toISOString(),
          newer: rowUpdated > mtime ? 'row' : mtime > rowUpdated ? 'file' : 'same',
          rowHash: createHash('sha256')
            .update(serializeNote({ frontmatter: row.frontmatter, body: row.body } as OkfNote))
            .digest('hex'),
          fileHash: createHash('sha256').update(file.bytes).digest('hex'),
          differingFrontmatterKeys: keys,
          bodyDiffers,
          resolution: 'file-wins',
        })
      }
    }
  }
  c.file[fileClass]++
  if (serializeNoteForm === false) c.notSerializeNoteForm++

  // c/f. chosen content (Q5: file wins when it parses) and the file projection
  let projection: ProjectionClass
  if (fileClass === 'missing') projection = 'create'
  else if (fileClass === 'unparseable') projection = 'rewrite'
  else projection = serializeNoteForm ? 'applied' : 'adopted'
  c.projection[projection]++
  if (projection === 'create' || projection === 'rewrite') {
    report.filesThatChangeBytes.push({ noteId: row.id, vaultId: row.vault_id, path: relPath, reason: projection })
  }
  timings.files += performance.now() - t0

  // d. revisions: compared with the row as it stands before the backfill
  const revision: RevisionClass = !latest
    ? 'none'
    : latest.body === row.body && differingKeys(latest.frontmatter, row.frontmatter).length === 0
      ? 'consistent'
      : 'gap'
  c.revision[revision]++

  // §8 step 4a (S2b): the bin at the live note's current path
  let crdt: CrdtClass | null = null
  if (!trashed) {
    const t1 = performance.now()
    const bin = await readMaybe(join(vaultsDir, row.vault_id, '.crdt', `${row.path}.bin`))
    if (!bin) crdt = 'missing'
    else {
      report.sizes.crdtBytes += bin.bytes.byteLength
      let text: string | null = null
      try {
        const doc = new Y.Doc()
        Y.applyUpdate(doc, new Uint8Array(bin.bytes.buffer, bin.bytes.byteOffset, bin.bytes.byteLength))
        text = doc.getText('body').toString()
        doc.destroy()
      } catch {
        text = null
      }
      if (text === null) crdt = 'undecodable'
      else if (text === row.body) crdt = 'matches-row'
      else if (parsed && text === parsed.body) crdt = 'matches-file'
      else {
        const t2 = performance.now()
        const [hit] = await tx`select 1 from note_revisions where note_id = ${row.id} and body = ${text} limit 1`
        timings.database += performance.now() - t2
        crdt = hit ? 'matches-revision' : 'mismatch'
      }
    }
    c.crdt[crdt]++
    timings.crdt += performance.now() - t1
  }

  const embedding = row.has_embedding ? 'applied' : 'pending'
  if (embedding === 'pending') c.embeddingPending++

  report.notes.push({
    noteId: row.id,
    vaultId: row.vault_id,
    path: row.path,
    trashed,
    file: fileClass,
    serializeNoteForm,
    revision,
    crdt,
    projection,
    embedding,
    ...(detail === undefined ? {} : { detail }),
  })
}
