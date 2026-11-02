import { and, eq, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositoryChanges, repositoryFiles, repositoryVersions } from '../db/schema.js'

/** A refusal of a `changed_since` value; the MCP layer turns it into the tool's error. */
export class ChangedSinceError extends Error {}

export interface ChangedFile {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  language: string | null
  size: number | null
}

/**
 * The files whose indexed content changed since `since` (#471): a commit SHA (full or a prefix of at least 7 hex
 * characters, as recorded by a sync) or an ISO date or time. The history is the index's own: a version per sync that
 * changed files or the commit (the git mirror is depth 1, so git's history is not available), dated by sync time.
 * A date means the newest version indexed at or before it; a commit, the newest version that named it. The changes of
 * every version after it are folded per path (added then deleted is nothing; deleted then added is modified), in
 * path byte order (`COLLATE "C"`) after `after`, under `folder` when given, at most `limit` of them. `base` is the
 * version they are measured from: null when `since` predates every recorded version (`historyStartsAt` then says where the history begins: the files of that first version are not changes).
 */
export async function changedSince(
  repositoryId: string,
  since: string,
  opts: { folder: string | null; after: string | null; limit: number },
): Promise<{ base: { commit: string | null; at: string } | null; historyStartsAt: string | null; files: ChangedFile[] }> {
  const versions = repositoryVersions
  let base: { seq: number; commit: string | null; indexedAt: Date } | undefined
  let historyStartsAt: string | null = null
  if (/^[0-9a-f]{7,64}$/i.test(since)) {
    const rows = await db
      .select({ seq: versions.seq, commit: versions.commit, indexedAt: versions.indexedAt })
      .from(versions)
      .where(and(eq(versions.repositoryId, repositoryId), sql`${versions.commit} like ${`${since.toLowerCase()}%`}`))
      .orderBy(sql`${versions.seq} desc`)
    if (rows.length === 0) throw new ChangedSinceError('commit not in the index history (repository_status names the indexed commit)')
    if (new Set(rows.map((r) => r.commit)).size > 1) throw new ChangedSinceError('commit prefix is ambiguous: give more characters')
    base = rows[0]
  } else {
    // Dates and date-times without an offset are UTC, whatever the server's TZ.
    const shaped = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(since)
    const at = shaped ? new Date(/[T ][0-9:.]+$/.test(since) ? `${since.replace(' ', 'T')}Z` : since) : null
    if (!at || Number.isNaN(at.getTime())) throw new ChangedSinceError('changed_since is a commit SHA (7+ hex) or an ISO date like 2026-10-31 or 2026-10-31T12:00:00Z')
    const [row] = await db
      .select({ seq: versions.seq, commit: versions.commit, indexedAt: versions.indexedAt })
      .from(versions)
      .where(and(eq(versions.repositoryId, repositoryId), sql`${versions.indexedAt} <= ${at.toISOString()}`))
      .orderBy(sql`${versions.seq} desc`)
      .limit(1)
    base = row
    if (!row) {
      const [first] = await db.select({ at: versions.indexedAt }).from(versions).where(eq(versions.repositoryId, repositoryId)).orderBy(sql`${versions.seq} asc`).limit(1)
      historyStartsAt = first?.at.toISOString() ?? null
    }
  }
  const path = sql`${repositoryChanges.path} collate "C"`
  const where: SQL[] = [eq(repositoryChanges.repositoryId, repositoryId), sql`${repositoryChanges.seq} > ${base?.seq ?? 0}`]
  if (opts.folder !== null) where.push(sql`${path} >= ${`${opts.folder}/`}`, sql`${path} < ${`${opts.folder}0`}`)
  if (opts.after !== null) where.push(sql`${path} > ${opts.after}`)
  // First and last change per path decide the net one.
  const first = sql<string>`(array_agg(${repositoryChanges.kind} order by ${repositoryChanges.seq}))[1]`
  const last = sql<string>`(array_agg(${repositoryChanges.kind} order by ${repositoryChanges.seq} desc))[1]`
  const rows = await db
    .select({ path: repositoryChanges.path, first, last })
    .from(repositoryChanges)
    .where(and(...where))
    .groupBy(repositoryChanges.path)
    .having(sql`not (${first} = 'added' and ${last} = 'deleted')`)
    .orderBy(path)
    .limit(opts.limit)
  const live = rows.length === 0 ? [] : await db
    .select({ path: repositoryFiles.path, language: repositoryFiles.language, size: repositoryFiles.size })
    .from(repositoryFiles)
    .where(and(eq(repositoryFiles.repositoryId, repositoryId), sql`${repositoryFiles.path} in ${rows.map((r) => r.path)}`))
  const byPath = new Map(live.map((f) => [f.path, f]))
  return {
    base: base ? { commit: base.commit, at: base.indexedAt.toISOString() } : null,
    historyStartsAt,
    files: rows.map((r) => {
      const file = byPath.get(r.path)
      return {
        path: r.path,
        kind: r.last === 'deleted' ? 'deleted' : r.first === 'added' ? 'added' : 'modified',
        language: file?.language ?? null,
        size: file?.size ?? null,
      }
    }),
  }
}
