import type AdmZip from 'adm-zip'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { mcpConnections, noteRevisions, notes, users } from '../db/schema.js'
import { createNote, isSafeAssetName, softDeleteNote, writeAsset, type Actor } from '../notes/store.js'
import { resolveNotePath } from '../notes/okf/paths.js'
import { parseNote, OkfValidationError } from '../notes/okf.js'

/**
 * A vault export's history (#499): one `.elara/history/<noteId>.json` per note,
 * live or trashed, next to the OKF tree. The `.md` files stay the live notes
 * exactly as stored; history carries what OKF has no place for: every
 * revision with its author and time, the note's own times, and trashed notes
 * (their content too, since they have no `.md`). Times are microsecond UTC
 * text, so revisions recorded within one millisecond keep their order.
 */
export const HISTORY_PREFIX = '.elara/history/'

/** Microsecond UTC text of a timestamptz column (a JS Date keeps milliseconds only). */
const utcText = (column: unknown) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const revisionSchema = z.object({
  action: z.string().min(1),
  actorType: z.enum(['user', 'mcp', 'collab']),
  actorId: z.string().nullable(),
  /** Set for user actors, so an import can tell whether the author is the importer. */
  actorEmail: z.string().optional(),
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string(),
  createdAt: z.string().regex(TIME),
})

const historySchema = z.object({
  path: z.string().min(1),
  createdAt: z.string().regex(TIME),
  updatedAt: z.string().regex(TIME),
  deletedAt: z.string().regex(TIME).nullable(),
  /** Trashed notes only: the content a live note keeps in its `.md`. */
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  body: z.string().optional(),
  /** Oldest first. */
  revisions: z.array(revisionSchema),
})

export type NoteHistory = z.infer<typeof historySchema>

/** Adds every note's history (live and trashed) of a vault to an export zip. */
export async function addHistoryToZip(zip: AdmZip, vaultId: string, prefix = ''): Promise<void> {
  const rows = await db
    .select({
      id: notes.id,
      path: notes.path,
      frontmatter: notes.frontmatter,
      body: notes.body,
      trashed: sql<boolean>`${notes.deletedAt} is not null`,
      createdAt: utcText(notes.createdAt),
      updatedAt: utcText(notes.updatedAt),
      deletedAt: sql<string | null>`case when ${notes.deletedAt} is null then null else ${utcText(notes.deletedAt)} end`,
    })
    .from(notes)
    .where(eq(notes.vaultId, vaultId))
    .orderBy(asc(notes.path), asc(notes.createdAt), asc(notes.id))
  const emailById = new Map<string, string>()
  for (const row of rows) {
    // Per note, so an export never holds every revision body of a vault in one result.
    const revisions = await db
      .select({
        action: noteRevisions.action,
        actorType: noteRevisions.actorType,
        actorId: noteRevisions.actorId,
        frontmatter: noteRevisions.frontmatter,
        body: noteRevisions.body,
        createdAt: utcText(noteRevisions.createdAt),
      })
      .from(noteRevisions)
      .where(eq(noteRevisions.noteId, row.id))
      .orderBy(asc(noteRevisions.createdAt), asc(noteRevisions.id))
    const unknownUsers = [
      ...new Set(
        revisions.flatMap((r) => (r.actorType === 'user' && r.actorId && !emailById.has(r.actorId) ? [r.actorId] : [])),
      ),
    ]
    if (unknownUsers.length) {
      const found = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, unknownUsers))
      for (const u of found) emailById.set(u.id, u.email)
    }
    const history: NoteHistory = {
      path: row.path,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      ...(row.trashed ? { frontmatter: row.frontmatter as Record<string, unknown>, body: row.body } : {}),
      revisions: revisions.map((r) => ({
        action: r.action,
        actorType: r.actorType,
        actorId: r.actorId,
        ...(r.actorType === 'user' && r.actorId && emailById.has(r.actorId)
          ? { actorEmail: emailById.get(r.actorId) }
          : {}),
        frontmatter: r.frontmatter as Record<string, unknown>,
        body: r.body,
        createdAt: r.createdAt,
      })),
    }
    zip.addFile(`${prefix}${HISTORY_PREFIX}${row.id}.json`, Buffer.from(JSON.stringify(history), 'utf8'))
  }
}

export interface ImportedVaultContent {
  /** Live notes created. */
  imported: number
  /** Trashed notes recreated in the new vault's trash. */
  trashed: number
  /** Entries left out, each `<path>: <reason>`. */
  skipped: string[]
}

/** Who a revision is attributed to in the new vault. */
interface Importer {
  id: string
  email: string
}

const ASSET_LINK = /\/api\/vaults\/([0-9a-fA-F-]{36})\/assets\/([A-Za-z0-9._%-]+)/g

/**
 * Fills a freshly created vault from an export archive: assets under their own
 * names, trashed notes, live notes, then each note's recorded history (new ids,
 * the archive's order and times). Archives without history (exports from
 * before #499) import their live notes and assets only.
 *
 * Attachment links `/api/vaults/<source vault>/assets/<name>` whose file came
 * with the archive are pointed at the new vault, in note bodies, frontmatter
 * strings, trashed notes and revisions. Without a source vault id in the
 * manifest (older exports) a link to any vault is rewritten when its file name
 * is one of the archive's assets.
 *
 * The archive is whatever the uploader wrote, so revision authors are not
 * trusted: a revision keeps its author only when that author is the importer
 * (user by id or email, MCP connection the importer owns). Every other
 * revision keeps its actor kind and loses its id, so an archive cannot
 * attribute edits to another account on this instance.
 */
export async function importVaultContent(
  zip: AdmZip,
  vaultId: string,
  sourceVaultId: string | undefined,
  importer: Importer,
): Promise<ImportedVaultContent> {
  const actor: Actor = { type: 'user', id: importer.id }
  const skipped: string[] = []

  const assetNames = new Set<string>()
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith('assets/')) continue
    const assetName = entry.entryName.slice('assets/'.length)
    if (!isSafeAssetName(assetName)) continue
    await writeAsset(vaultId, assetName, entry.getData())
    assetNames.add(assetName)
  }
  const rewriteLinks = (text: string): string =>
    text.replace(ASSET_LINK, (link, fromVault: string, encoded: string) => {
      if (sourceVaultId && fromVault.toLowerCase() !== sourceVaultId.toLowerCase()) return link
      let fileName: string
      try {
        fileName = decodeURIComponent(encoded)
      } catch {
        return link
      }
      return assetNames.has(fileName) ? `/api/vaults/${vaultId}/assets/${encoded}` : link
    })
  // Strings anywhere in the frontmatter; every other value (dates, numbers) stays as parsed.
  const rewriteValue = (value: unknown): unknown => {
    if (typeof value === 'string') return rewriteLinks(value)
    if (Array.isArray(value)) return value.map(rewriteValue)
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteValue(v)]))
    }
    return value
  }
  const rewriteFrontmatter = (frontmatter: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(frontmatter).map(([k, v]) => [k, rewriteValue(v)]))

  const liveHistory = new Map<string, NoteHistory>()
  const trashHistory: NoteHistory[] = []
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith(HISTORY_PREFIX)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(entry.getData().toString('utf8'))
    } catch {
      skipped.push(`${entry.entryName}: not JSON`)
      continue
    }
    const history = historySchema.safeParse(parsed)
    if (!history.success) {
      skipped.push(`${entry.entryName}: not a note history`)
      continue
    }
    if (history.data.deletedAt === null) liveHistory.set(history.data.path, history.data)
    else trashHistory.push(history.data)
  }

  const ownedConnections = new Set(
    (
      await db
        .select({ id: mcpConnections.id })
        .from(mcpConnections)
        .where(eq(mcpConnections.userId, importer.id))
    ).map((c) => c.id),
  )
  const importerEmail = importer.email.toLowerCase()
  const attributedId = (revision: NoteHistory['revisions'][number]): string | null => {
    const id = revision.actorId && UUID.test(revision.actorId) ? revision.actorId.toLowerCase() : null
    if (revision.actorType === 'user') {
      return id === importer.id || revision.actorEmail?.toLowerCase() === importerEmail ? importer.id : null
    }
    if (revision.actorType === 'mcp') return id && ownedConnections.has(id) ? id : null
    return null
  }

  /** Replaces the revisions the import recorded with the archive's, and restores the note's times. */
  const applyHistory = async (noteId: string, history: NoteHistory): Promise<void> => {
    await db.transaction(async (tx) => {
      await tx.delete(noteRevisions).where(eq(noteRevisions.noteId, noteId))
      if (history.revisions.length) {
        await tx.insert(noteRevisions).values(
          history.revisions.map((r) => ({
            noteId,
            actorType: r.actorType,
            actorId: attributedId(r),
            action: r.action,
            frontmatter: rewriteFrontmatter(r.frontmatter),
            body: rewriteLinks(r.body),
            createdAt: sql`${r.createdAt}::timestamptz`,
          })),
        )
      }
      await tx
        .update(notes)
        .set({
          createdAt: sql`${history.createdAt}::timestamptz`,
          updatedAt: sql`${history.updatedAt}::timestamptz`,
          ...(history.deletedAt ? { deletedAt: sql`${history.deletedAt}::timestamptz` } : {}),
        })
        .where(and(eq(notes.id, noteId), eq(notes.vaultId, vaultId)))
    })
  }

  const create = async (path: string, frontmatter: Record<string, unknown>, body: string) => {
    const resolved = resolveNotePath(path)
    // Same shared validation write path as every other write.
    return createNote(
      vaultId,
      {
        path: resolved.fullPath,
        type: resolved.type,
        name: resolved.name,
        frontmatter: rewriteFrontmatter(frontmatter),
        body: rewriteLinks(body),
      },
      actor,
    )
  }

  // Trash first: a path can be both trashed and live, and only one live note may hold it.
  let trashed = 0
  for (const history of trashHistory) {
    if (!history.frontmatter || history.body === undefined) {
      skipped.push(`${history.path} (trash): no content`)
      continue
    }
    try {
      const row = await create(history.path, history.frontmatter, history.body)
      await softDeleteNote(vaultId, row.path, actor)
      await applyHistory(row.id, history)
      trashed += 1
    } catch (err) {
      if (err instanceof OkfValidationError) skipped.push(`${history.path} (trash): ${err.message}`)
      else throw err
    }
  }

  let imported = 0
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.endsWith('.md')) continue
    const path = entry.entryName.replace(/\.md$/, '')
    if (path === 'index' || path.endsWith('/index')) continue
    try {
      const parsed = parseNote(entry.getData().toString('utf8'))
      const row = await create(path, parsed.frontmatter, parsed.body)
      const history = liveHistory.get(row.path)
      if (history) await applyHistory(row.id, history)
      imported += 1
    } catch (err) {
      if (err instanceof OkfValidationError) skipped.push(`${path}: ${err.message}`)
      else throw err
    }
  }
  return { imported, trashed, skipped }
}
