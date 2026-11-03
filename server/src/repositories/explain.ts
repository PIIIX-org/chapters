/**
 * What `find_symbols` with `refs: "explain"` (#675) reads besides the code
 * queries (code-queries.ts): the definition's declaration line and the live
 * notes that cite its file. A note cites a file with a wikilink
 * the graph resolves (`repo:<name or id>/<path>`, also `code:` and `:` before the path; `note_links`, #472: the
 * target is the file, an anchor is not stored; one citation per note, its first link). Freshness is about the file, not the text of the
 * note: `current` when the note was last written at or after the file last
 * changed, else `stale` (the file changed after it). Callers pass the vaults
 * the account may read; nothing here checks access.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repoLinkTarget } from '../graph/assemble.js'
import { blocks, noteLinks, notes, repositories, repositoryFiles } from '../db/schema.js'

/** Citing link rows read for one answer (the first link of each note is kept): more than the section shows, so the answer can say more exist. */
export const CITATION_ROWS = 50

export interface Citation {
  vaultId: string
  path: string
  frontmatter: unknown
  frontmatterSrc: unknown
  /** Body-relative lines of the link (0 for a row not located yet). */
  startLine: number
  endLine: number
  context: string | null
  fresh: boolean
}

/** The first non-blank line of a symbol block's snippet: its declaration. */
export async function declarationOf(blockId: string): Promise<string | null> {
  const [row] = await db.select({ snippet: blocks.snippet }).from(blocks).where(eq(blocks.id, blockId))
  return row?.snippet?.split('\n').find((l) => l.trim() !== '')?.trim() ?? null
}

/** Live notes of `vaultIds` that link file `path` of the repository, by note path (code units), then line. */
export async function citationsOf(repositoryId: string, path: string, vaultIds: readonly string[]): Promise<Citation[]> {
  if (vaultIds.length === 0) return []
  const [repo] = await db.select({ name: repositories.name }).from(repositories).where(eq(repositories.id, repositoryId))
  const [file] = await db.select({ updatedAt: repositoryFiles.updatedAt }).from(repositoryFiles).where(and(eq(repositoryFiles.repositoryId, repositoryId), eq(repositoryFiles.path, path)))
  if (!repo || !file) return []
  // The stored forms a link to this file can have (`repoLinkTarget`, graph/assemble.ts, is the resolver that reads them):
  // `repo:` or `code:`, the repository's name or id, `/` or `:` before the path. Plain equality on `target_path`, so
  // `note_links_target_idx` serves it; the resolver then confirms each row, which keeps its rules (case included).
  const targets = ['repo', 'code'].flatMap((scheme) => [repo.name, repositoryId].flatMap((key) => [`${scheme}:${key}/${path}`, `${scheme}:${key}:${path}`]))
  const resolvable = new Map([[repo.name, repositoryId]])
  const rows = await db
    .select({
      vaultId: notes.vaultId,
      path: notes.path,
      frontmatter: notes.frontmatter,
      frontmatterSrc: sql<unknown>`frontmatter_src`,
      updatedAt: notes.updatedAt,
      startLine: noteLinks.startLine,
      endLine: noteLinks.endLine,
      context: noteLinks.context,
      target: noteLinks.targetPath,
    })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .where(and(inArray(notes.vaultId, [...vaultIds]), isNull(notes.deletedAt), inArray(noteLinks.targetPath, targets)))
    .orderBy(sql`${notes.path} COLLATE "C"`, sql`${notes.vaultId}`, noteLinks.startLine)
    .limit(CITATION_ROWS + 1)
  const seen = new Set<string>()
  const cites: Citation[] = []
  for (const { updatedAt, target, ...r } of rows) {
    const named = repoLinkTarget(target, resolvable, [repositoryId])
    const key = `${r.vaultId}/${r.path}`
    if (!named || named.path !== path || seen.has(key)) continue
    seen.add(key)
    cites.push({ ...r, fresh: updatedAt >= file.updatedAt })
  }
  return cites
}
