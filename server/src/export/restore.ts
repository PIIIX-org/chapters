import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { instanceState, noteLinks, securityEvents, users } from '../db/schema.js'
import { atomicWrite } from '../notes/atomic-write.js'
import {
  assetFile,
  isSafeAssetName,
  noteFile,
  resolveNotePath,
  trashFile,
} from '../notes/store.js'
import { reconcileStore } from '../notes/store-reconcile.js'
import { flushProjections, projectDirIndices } from '../notes/projector.js'
import {
  OkfValidationError,
  extractWikilinks,
  parseNote,
  serializeNote,
  validateNote,
  type Frontmatter,
} from '../notes/okf.js'
import {
  BACKUP_FORMAT,
  BACKUP_MANIFEST,
  BACKUP_TABLES,
  INSTANCE_STATE,
  LEGACY_DUMP,
  assetEntry,
  backupColumns,
  foreignKeysOf,
  noteEntry,
  partOf,
  primaryKeyOf,
  tableEntry,
  timestampKeysOf,
  trashEntry,
  type BackupTable,
  type Row,
} from './backup-format.js'

/** The archive is unreadable, incomplete or inconsistent. Nothing was written. */
export class BackupInvalidError extends Error {}

/** The plan has conflicts with what is already on this instance. Nothing was written. */
export class RestoreRefusedError extends Error {
  constructor(readonly plan: RestorePlan) {
    super(`Refusing to restore: ${plan.conflicts.join('; ')}`)
  }
}

export interface TablePlan {
  table: string
  inArchive: number
  toRestore: number
  /** Rows whose id is already here: kept as they are. */
  present: number
}

export interface FilePlan {
  kind: 'notes' | 'trash' | 'attachments'
  inArchive: number
  toWrite: number
  present: number
}

/** What a restore does. Counts and messages only: never a secret, hash or note content. */
export interface RestorePlan {
  format: number
  /** SHA-256 of the archive; recorded on the instance by the restore. */
  archive: string
  /**
   * When this instance was restored from this archive (ISO time), else null.
   * The rows and the marker commit together, so a restore that ran is
   * complete: a re-run writes nothing (it would bring back what was deleted
   * since, such as shares or rotated MFA backup codes).
   */
  alreadyRestored: string | null
  tables: TablePlan[]
  files: FilePlan[]
  /** Data the restore leaves out or can't bring back; it still runs. */
  warnings: string[]
  /** Reasons the restore refuses to run. */
  conflicts: string[]
}

interface BackupFile {
  kind: FilePlan['kind']
  vaultId: string
  /** Note path (notes), note id (trash) or file name (attachments). */
  name: string
  noteId?: string
  data: Buffer | string
}

interface BackupContents {
  format: number
  archive: string
  tables: Map<string, Row[]>
  instanceState: Row | null
  files: BackupFile[]
  warnings: string[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RESTORE_EVENT = 'instance_restored'

const keyOf = (row: Row, keys: string[]): string => JSON.stringify(keys.map((k) => row[k] ?? null))

function isObject(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(data: Buffer, entry: string): unknown {
  try {
    return JSON.parse(data.toString('utf8'))
  } catch (err) {
    throw new BackupInvalidError(`${entry} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * An archive row -> an insertable row: only this schema's columns, the
 * primary key present, JSON's date strings back to Dates. `strict` refuses a
 * column this version does not know (an archive from a newer schema);
 * otherwise the column is dropped with a warning.
 */
function toInsertable(spec: BackupTable, raw: unknown, where: string, strict: boolean, warnings: string[]): Row {
  if (!isObject(raw)) throw new BackupInvalidError(`${where}: not a JSON object`)
  const columns = backupColumns(spec)
  const row: Row = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key in columns) row[key] = value
    else if (strict) throw new BackupInvalidError(`${where}: column "${key}" is unknown to this version: was the archive made by a newer Elara?`)
    else if (!warnings.some((w) => w.startsWith(`${spec.name}.${key} `))) warnings.push(`${spec.name}.${key} is no longer a column: left out`)
  }
  for (const key of primaryKeyOf(spec.table)) {
    if (row[key] == null) throw new BackupInvalidError(`${where}: primary key "${key}" is missing`)
  }
  for (const key of timestampKeysOf(spec.table)) {
    const value = row[key]
    if (value == null) continue
    const date = new Date(String(value))
    if (Number.isNaN(date.getTime())) throw new BackupInvalidError(`${where}: "${key}" is not a date`)
    row[key] = date
  }
  return row
}

function noteContent(row: Row): string {
  const frontmatter = isObject(row.frontmatter) ? row.frontmatter : {}
  return serializeNote({ frontmatter: { ...frontmatter, type: String(frontmatter.type ?? row.type) }, body: String(row.body) })
}

const NO_DIGESTS = 'has no SHA-256 digests (made before #493): only the zip checksums were checked'

/**
 * Every entry against `backup.json`'s `parts` (#493): each listed part is
 * present with its size and SHA-256, and nothing unlisted was added. The zip's
 * CRCs miss a part rewritten (or cut short) in a valid zip, and a missing note
 * file would otherwise fall back to the row's copy without a word.
 */
function verifyParts(entries: Map<string, Buffer>, parts: unknown, warnings: string[]): void {
  if (parts === undefined) {
    warnings.push(`${BACKUP_MANIFEST} ${NO_DIGESTS}`)
    return
  }
  if (!isObject(parts)) throw new BackupInvalidError(`${BACKUP_MANIFEST}: "parts" is not an object`)
  for (const [name, part] of Object.entries(parts)) {
    if (!isObject(part) || typeof part.sha256 !== 'string' || typeof part.size !== 'number') {
      throw new BackupInvalidError(`${BACKUP_MANIFEST}: the entry for ${name} is malformed`)
    }
    const data = entries.get(name)
    if (!data) throw new BackupInvalidError(`${name} is listed in ${BACKUP_MANIFEST} but missing: the archive is incomplete`)
    if (data.length !== part.size) {
      throw new BackupInvalidError(`${name} is ${data.length} bytes, ${BACKUP_MANIFEST} says ${part.size}: the archive is truncated or damaged`)
    }
    if (partOf(data).sha256 !== part.sha256) {
      throw new BackupInvalidError(`${name} does not match its SHA-256 in ${BACKUP_MANIFEST}: the archive was changed or damaged after the backup`)
    }
  }
  for (const name of entries.keys()) {
    if (name !== BACKUP_MANIFEST && !Object.hasOwn(parts, name)) {
      throw new BackupInvalidError(`${name} is not listed in ${BACKUP_MANIFEST}: the archive was changed after the backup`)
    }
  }
}

/** Format 2: `backup.json` + `db/<table>.jsonl` + files under `vaults/<id>/`. */
function readCurrentFormat(entries: Map<string, Buffer>, archive: string): BackupContents {
  const manifest = parseJson(entries.get(BACKUP_MANIFEST)!, BACKUP_MANIFEST)
  if (!isObject(manifest) || typeof manifest.format !== 'number') {
    throw new BackupInvalidError(`${BACKUP_MANIFEST} has no format version`)
  }
  if (manifest.format > BACKUP_FORMAT) {
    throw new BackupInvalidError(
      `the archive is format ${manifest.format}, made by a newer Elara; this version restores formats 1 to ${BACKUP_FORMAT}: upgrade first`,
    )
  }
  if (manifest.format !== BACKUP_FORMAT) throw new BackupInvalidError(`${BACKUP_MANIFEST} has an unknown format ${manifest.format}`)
  const counts = isObject(manifest.tables) ? manifest.tables : {}

  const warnings: string[] = []
  verifyParts(entries, manifest.parts, warnings)
  // Archives made before ADR-003 S2a-2 read note files from disk and left out the ones that no longer matched their row.
  if (typeof manifest.notesFromRow === 'number' && manifest.notesFromRow > 0) {
    warnings.push(
      `${manifest.notesFromRow} note(s) were saved while the backup ran: their newer file was left out, they are restored as of the backup's snapshot`,
    )
  }
  const tables = new Map<string, Row[]>()
  for (const spec of [...BACKUP_TABLES, INSTANCE_STATE]) {
    const entry = tableEntry(spec.name)
    const data = entries.get(entry)
    if (!data) throw new BackupInvalidError(`${entry} is missing: the archive is incomplete`)
    const lines = data.toString('utf8').split('\n').filter((line) => line !== '')
    const rows = lines.map((line, i) => {
      const where = `${entry} line ${i + 1}`
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        throw new BackupInvalidError(`${where}: not valid JSON`)
      }
      return toInsertable(spec, raw, where, true, warnings)
    })
    if (counts[spec.name] !== rows.length) {
      throw new BackupInvalidError(`${entry} has ${rows.length} rows, ${BACKUP_MANIFEST} says ${String(counts[spec.name])}: the archive is damaged`)
    }
    tables.set(spec.name, rows)
  }

  const files: BackupFile[] = []
  for (const note of tables.get('notes')!) {
    const vaultId = String(note.vaultId)
    const noteId = String(note.id)
    const path = String(note.path)
    if (!UUID.test(vaultId) || !UUID.test(noteId)) throw new BackupInvalidError(`db/notes.jsonl: note ${noteId} has a malformed id`)
    let resolved: string
    try {
      resolved = resolveNotePath(path).fullPath
    } catch (err) {
      throw new BackupInvalidError(`db/notes.jsonl: note ${noteId} has an invalid path: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (resolved !== path) throw new BackupInvalidError(`db/notes.jsonl: note ${noteId} has a non-canonical path`)
    // The archive's rendering of the row (older archives: the file as it was on disk); the row when the archive has no entry.
    if (note.deletedAt == null) {
      files.push({ kind: 'notes', vaultId, name: path, noteId, data: entries.get(noteEntry(vaultId, path)) ?? noteContent(note) })
    } else {
      files.push({ kind: 'trash', vaultId, name: noteId, noteId, data: entries.get(trashEntry(vaultId, noteId)) ?? noteContent(note) })
    }
  }
  const vaultIds = new Set(tables.get('vaults')!.map((v) => String(v.id)))
  for (const [name, data] of entries) {
    const match = /^vaults\/([^/]+)\/assets\/(.+)$/.exec(name)
    const vaultId = match?.[1]
    const fileName = match?.[2]
    if (!vaultId || !fileName) continue
    if (!vaultIds.has(vaultId)) throw new BackupInvalidError(`${name}: attachment of a vault the archive does not have`)
    if (!isSafeAssetName(fileName) || assetEntry(vaultId, fileName) !== name) throw new BackupInvalidError(`${name}: unsafe attachment name`)
    files.push({ kind: 'attachments', vaultId, name: fileName, data })
  }

  return { format: BACKUP_FORMAT, archive, tables, instanceState: tables.get(INSTANCE_STATE.name)![0] ?? null, files, warnings }
}

/** A stable id from a name, so restoring a format-1 archive twice gives its notes the same ids. */
function derivedUuid(name: string): string {
  const h = createHash('sha256').update(name).digest('hex')
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * Format 1 (`account-dump.json`, before #409): eight account tables and the
 * live note files. Notes get ids derived from vault and path and one
 * `create` revision each; trash, revisions, repositories and MFA secrets
 * were never in it.
 */
function readLegacyFormat(entries: Map<string, Buffer>, archive: string): BackupContents {
  const dump = parseJson(entries.get(LEGACY_DUMP)!, LEGACY_DUMP)
  if (!isObject(dump)) throw new BackupInvalidError(`${LEGACY_DUMP} is not a JSON object`)
  const warnings: string[] = [`${LEGACY_DUMP} (format 1) ${NO_DIGESTS}`]
  const tables = new Map<string, Row[]>()
  for (const spec of BACKUP_TABLES) {
    const raw = spec.legacyKey ? dump[spec.legacyKey] : []
    if (!Array.isArray(raw)) throw new BackupInvalidError(`${LEGACY_DUMP}: "${spec.legacyKey}" is missing: the archive is incomplete`)
    tables.set(
      spec.name,
      raw.map((row, i) => toInsertable(spec, row, `${LEGACY_DUMP} ${spec.legacyKey}[${i}]`, false, warnings)),
    )
  }

  // A dump from before migration 0019 has no access level: apply the migration's rule.
  const connections: Row[] = tables
    .get('mcp_connections')!
    .map((c) => ({ ...c, access: c.access ?? (c.scope === 'account' ? 'admin' : 'write') }))
  const pinnedToRepo = connections.filter((c) => c.repositoryId != null)
  if (pinnedToRepo.length > 0) {
    warnings.push(`${pinnedToRepo.length} repository-scoped MCP token(s) left out: a format-1 archive has no repositories`)
  }
  tables.set('mcp_connections', connections.filter((c) => c.repositoryId == null))
  const mfaLost = tables.get('users')!.filter((u) => u.mfaEnabledAt != null && u.totpSecret == null).length
  if (mfaLost > 0) {
    warnings.push(
      `${mfaLost} user(s) have MFA on but a format-1 archive has no TOTP secrets: they can't sign in ` +
        'until their MFA is cleared in the database (docs/self-hosting/backup.md)',
    )
  }

  const owners = new Map(tables.get('vaults')!.map((v) => [String(v.id), v.ownerId]))
  const now = new Date()
  const noteRows: Row[] = []
  const revisionRows: Row[] = []
  const files: BackupFile[] = []
  const skippedVaults = new Set<string>()
  for (const [name, data] of entries) {
    const asset = /^vaults\/([^/]+)\/assets\/(.+)$/.exec(name)
    const note = asset ? null : /^vaults\/([^/]+)\/(.+)\.md$/.exec(name)
    const vaultId = asset?.[1] ?? note?.[1]
    if (!vaultId) continue
    if (!owners.has(vaultId)) {
      skippedVaults.add(vaultId)
      continue
    }
    if (asset) {
      const fileName = asset[2]!
      if (!isSafeAssetName(fileName)) throw new BackupInvalidError(`${name}: unsafe attachment name`)
      files.push({ kind: 'attachments', vaultId, name: fileName, data })
      continue
    }
    const path = note![2]!
    // Generated progressive-disclosure indices, rebuilt after the restore.
    if (path === 'index' || path.endsWith('/index')) continue
    try {
      const resolved = resolveNotePath(path)
      const parsed = parseNote(data.toString('utf8'))
      const frontmatter: Frontmatter = {
        timestamp: now.toISOString(),
        ...parsed.frontmatter,
        type: parsed.frontmatter.type ? String(parsed.frontmatter.type) : resolved.type,
      }
      validateNote(resolved.type, resolved.name, frontmatter, parsed.body)
      const id = derivedUuid(`note:${vaultId}/${resolved.fullPath}`)
      const row = {
        id,
        vaultId,
        type: resolved.type,
        name: resolved.name,
        path: resolved.fullPath,
        frontmatter,
        body: parsed.body,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      noteRows.push(row)
      revisionRows.push({
        id: derivedUuid(`revision:${id}`),
        noteId: id,
        actorType: 'user',
        actorId: owners.get(vaultId) ?? null,
        action: 'create',
        frontmatter,
        body: parsed.body,
        createdAt: now,
      })
      files.push({ kind: 'notes', vaultId, name: resolved.fullPath, noteId: id, data: noteContent(row) })
    } catch (err) {
      if (!(err instanceof OkfValidationError)) throw err
      warnings.push(`note skipped: ${vaultId}/${path}: ${err.message}`)
    }
  }
  if (skippedVaults.size > 0) warnings.push(`files of ${skippedVaults.size} vault(s) missing from ${LEGACY_DUMP} left out`)
  tables.set('notes', noteRows)
  tables.set('note_revisions', revisionRows)
  return { format: 1, archive, tables, instanceState: null, files, warnings }
}

/** Every row's parent is in the archive (the archive alone must be a consistent instance). */
function checkReferences(contents: BackupContents): void {
  const byTable = new Map(BACKUP_TABLES.map((spec) => [spec.table, spec]))
  const problems: string[] = []
  for (const spec of BACKUP_TABLES) {
    const rows = contents.tables.get(spec.name)!
    for (const fk of foreignKeysOf(spec.table)) {
      const parent = byTable.get(fk.parent)
      if (!parent) continue
      const parentKeys = new Set(contents.tables.get(parent.name)!.map((r) => keyOf(r, fk.parentKeys)))
      const orphans = rows.filter((r) => fk.keys.every((k) => r[k] != null) && !parentKeys.has(keyOf(r, fk.keys)))
      if (orphans.length > 0) {
        problems.push(`${spec.name}: ${orphans.length} row(s) point at ${parent.name} rows the archive does not have (${fk.keys.join(', ')})`)
      }
    }
  }
  if (problems.length > 0) throw new BackupInvalidError(`the archive is inconsistent: ${problems.join('; ')}`)
}

/** Validate: readable zip, known format, every part present, rows well formed and consistent. */
function readBackup(buffer: Buffer): BackupContents {
  const entries = new Map<string, Buffer>()
  try {
    // getData() checks each entry's CRC: a damaged entry fails here, before any write.
    for (const entry of new AdmZip(buffer).getEntries()) {
      if (!entry.isDirectory) entries.set(entry.entryName, entry.getData())
    }
  } catch (err) {
    throw new BackupInvalidError(`not a readable zip archive: ${err instanceof Error ? err.message : String(err)}`)
  }
  const archive = createHash('sha256').update(buffer).digest('hex')
  let contents: BackupContents
  if (entries.has(BACKUP_MANIFEST)) contents = readCurrentFormat(entries, archive)
  else if (entries.has(LEGACY_DUMP)) contents = readLegacyFormat(entries, archive)
  else throw new BackupInvalidError(`not an Elara instance backup: neither ${BACKUP_MANIFEST} nor ${LEGACY_DUMP} found`)
  checkReferences(contents)
  return contents
}

function fileTarget(file: BackupFile): string {
  if (file.kind === 'notes') return noteFile(file.vaultId, file.name)
  if (file.kind === 'trash') return trashFile(file.vaultId, file.name)
  return assetFile(file.vaultId, file.name)
}

interface PreparedRestore {
  plan: RestorePlan
  inserts: Map<string, Row[]>
  writes: BackupFile[]
}

/** Plan: what is new, what is already here (by id), and what would clash. Reads only. */
async function planRestore(contents: BackupContents): Promise<PreparedRestore> {
  const conflicts: string[] = []
  const warnings = [...contents.warnings]
  const [marker] = await db
    .select({ createdAt: securityEvents.createdAt })
    .from(securityEvents)
    .where(and(eq(securityEvents.type, RESTORE_EVENT), sql`${securityEvents.detail}->>'archive' = ${contents.archive}`))
    .limit(1)
  if (marker) {
    return {
      plan: { format: contents.format, archive: contents.archive, alreadyRestored: marker.createdAt.toISOString(), tables: [], files: [], warnings: [], conflicts: [] },
      inserts: new Map(),
      writes: [],
    }
  }
  const [userRow] = await db.select({ n: sql<number>`count(*)::int` }).from(users)
  const existingUsers = userRow?.n ?? 0
  if (existingUsers > 0) {
    conflicts.push(
      `this instance already has ${existingUsers} user(s) and was not restored from this archive. ` +
        'Restore only runs on an empty instance',
    )
  }

  const tables: TablePlan[] = []
  const inserts = new Map<string, Row[]>()
  for (const spec of BACKUP_TABLES) {
    const rows = contents.tables.get(spec.name)!
    const pk = primaryKeyOf(spec.table)
    const columns = backupColumns(spec)
    const wanted = new Set([...pk, ...(spec.unique?.flatMap((u) => u.columns) ?? [])])
    if (spec.unique?.some((u) => u.liveOnly)) wanted.add('deletedAt')
    const existing = await db
      .select(Object.fromEntries([...wanted].map((k) => [k, columns[k]!])))
      .from(spec.table)
    const present = new Set(existing.map((r) => keyOf(r, pk)))
    const toInsert = rows.filter((r) => !present.has(keyOf(r, pk)))
    for (const unique of spec.unique ?? []) {
      const live = (r: Row) => !unique.liveOnly || r.deletedAt == null
      const taken = new Set(existing.filter(live).map((r) => keyOf(r, unique.columns)))
      const clashes = toInsert.filter((r) => live(r) && taken.has(keyOf(r, unique.columns))).length
      if (clashes > 0) {
        conflicts.push(`${spec.name}: ${clashes} row(s) clash with a different existing row on (${unique.columns.join(', ')})`)
      }
    }
    inserts.set(spec.name, toInsert)
    tables.push({ table: spec.name, inArchive: rows.length, toRestore: toInsert.length, present: rows.length - toInsert.length })
  }

  // A note's file goes with its row: written only when the row is restored.
  const newNotes = new Set(inserts.get('notes')!.map((n) => String(n.id)))
  const writes: BackupFile[] = []
  const files: FilePlan[] = (['notes', 'trash', 'attachments'] as const).map((kind) => ({ kind, inArchive: 0, toWrite: 0, present: 0 }))
  let differing = 0
  // Notes whose file is already on disk with other content (a kept data volume): the archive's version replaces it.
  let replacedNotes = 0
  for (const file of contents.files) {
    const plan = files.find((f) => f.kind === file.kind)!
    plan.inArchive += 1
    let write: boolean
    if (file.kind !== 'attachments') {
      write = newNotes.has(file.noteId!)
      if (write) {
        const onDisk = await readFile(fileTarget(file)).catch(() => null)
        if (onDisk && !onDisk.equals(Buffer.from(file.data))) replacedNotes += 1
      }
    } else {
      const onDisk = await readFile(fileTarget(file)).catch(() => null)
      write = onDisk === null
      if (onDisk && !onDisk.equals(Buffer.from(file.data))) differing += 1
    }
    if (write) {
      plan.toWrite += 1
      writes.push(file)
    } else {
      plan.present += 1
    }
  }
  if (differing > 0) warnings.push(`${differing} attachment(s) already on disk differ from the archive: kept as they are`)
  if (replacedNotes > 0) {
    warnings.push(`${replacedNotes} note or trash file(s) already on disk differ from the archive: replaced by the archive's version`)
  }

  return {
    plan: { format: contents.format, archive: contents.archive, alreadyRestored: null, tables, files, warnings, conflicts },
    inserts,
    writes,
  }
}

/**
 * Brings the restored rows into the store (ADR-003 §8 "#776 coordination"):
 * boot reconciliation gives every restored note its projection rows and a
 * revision at its `seq`, then the projector writes (or adopts, when the
 * archive's file already holds the row's content) every file, and the
 * index.md of every directory of the archive's live notes is rendered again
 * from the rows (a crash after the commit can have left one missing).
 */
async function projectRestored(contents: BackupContents): Promise<void> {
  await reconcileStore()
  await flushProjections()
  const dirsByVault = new Map<string, Set<string>>()
  for (const note of contents.tables.get('notes')!) {
    if (note.deletedAt != null) continue
    const vaultId = String(note.vaultId)
    const dirs = dirsByVault.get(vaultId) ?? new Set<string>()
    for (const dir of resolveNotePath(String(note.path)).ancestorDirectories) dirs.add(dir)
    dirsByVault.set(vaultId, dirs)
  }
  for (const [vaultId, dirs] of dirsByVault) await projectDirIndices(vaultId, dirs)
}

/**
 * Apply: every row in one transaction, idempotent by primary key. Files are
 * written (each atomically) inside it, so a file that can't be written rolls
 * the rows back. If the transaction fails, the files it created are removed
 * again; files it replaced keep the archive's version (they belonged to no
 * row: the instance had no users).
 */
async function applyRestore(contents: BackupContents, { inserts, writes }: PreparedRestore): Promise<void> {
  const newNotes = inserts.get('notes')!
  const created: string[] = []
  try {
    await db.transaction(async (tx) => {
      for (const spec of BACKUP_TABLES) {
        const rows = inserts.get(spec.name)!.map((row) => (spec.onRestore ? spec.onRestore(row) : row))
        if (rows.length === 0) continue
        const columns = backupColumns(spec)
        const target = primaryKeyOf(spec.table).map((k) => columns[k]!)
        // Postgres takes at most 65535 bind parameters per statement.
        const size = Math.max(1, Math.floor(30_000 / Object.keys(columns).length))
        for (let i = 0; i < rows.length; i += size) {
          await tx
            .insert(spec.table)
            .values(rows.slice(i, i + size))
            .onConflictDoNothing({ target })
        }
      }
      // Derived from the bodies, as on every save.
      const links = newNotes.flatMap((n) => extractWikilinks(String(n.body)).map((targetPath) => ({ sourceNoteId: String(n.id), targetPath })))
      for (let i = 0; i < links.length; i += 10_000) {
        await tx.insert(noteLinks).values(links.slice(i, i + 10_000)).onConflictDoNothing()
      }
      // A restored instance needs no first-run setup; the setup token is never restored.
      if (contents.tables.get('users')!.length > 0) {
        const state = contents.instanceState
        const values = {
          setupTokenHash: null,
          setupCompletedAt: state?.setupCompletedAt instanceof Date ? state.setupCompletedAt : new Date(),
          ...(state ? { requireMfa: Boolean(state.requireMfa) } : {}),
        }
        await tx
          .insert(instanceState)
          .values({ id: 'singleton', ...values })
          .onConflictDoUpdate({ target: instanceState.id, set: values })
      }
      await tx.insert(securityEvents).values({ type: RESTORE_EVENT, detail: { archive: contents.archive, format: contents.format } })
      for (const file of writes) {
        const target = fileTarget(file)
        const existed = await stat(target).then(() => true, () => false)
        await atomicWrite(target, file.data)
        if (!existed) created.push(target)
      }
    })
  } catch (err) {
    await Promise.all(created.map((file) => rm(file, { force: true })))
    throw err
  }
  await projectRestored(contents)
}

/**
 * Restores a full-instance backup: validate the archive (format, parts,
 * integrity) -> plan (counts per table and file kind, conflicts) -> apply.
 * Ids are the archive's: a restore, not an import. Runs on an empty
 * instance only. On an instance already restored from this archive it
 * writes nothing (`alreadyRestored`), except index.md files a crash after
 * the commit left missing. Throws BackupInvalidError or RestoreRefusedError
 * with nothing written. Embeddings are not restored: the server computes
 * them on boot.
 */
export async function restoreBackup(buffer: Buffer, options: { dryRun?: boolean } = {}): Promise<RestorePlan> {
  const contents = readBackup(buffer)
  const prepared = await planRestore(contents)
  if (prepared.plan.conflicts.length > 0) throw new RestoreRefusedError(prepared.plan)
  if (options.dryRun) return prepared.plan
  if (prepared.plan.alreadyRestored) await projectRestored(contents)
  else await applyRestore(contents, prepared)
  return prepared.plan
}
