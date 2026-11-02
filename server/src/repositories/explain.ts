/**
 * What `find_symbols` with `refs: "explain"` (#675) reads besides the code
 * queries (code-queries.ts): the definition's declaration line and the live
 * notes that cite its file. A note cites a file with a wikilink
 * `[[repo:<name or id>/<path>]]` (`note_links`, #472: the target is the file,
 * an anchor is not stored). Freshness is about the file, not the text of the
 * note: `current` when the note was last written at or after the file last
 * changed, else `stale` (the file changed after it). Callers pass the vaults
 * the account may read; nothing here checks access.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { blocks, noteLinks, notes, repositories, repositoryFiles } from '../db/schema.js'

/** Citing links read for one answer: one more than the section shows, so the answer can say more exist. */
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
  const targets = [`repo:${repo.name}/${path}`.toLowerCase(), `repo:${repositoryId}/${path}`.toLowerCase()]
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
    })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .where(and(inArray(notes.vaultId, [...vaultIds]), isNull(notes.deletedAt), inArray(sql`lower(${noteLinks.targetPath})`, targets)))
    .orderBy(sql`${notes.path} COLLATE "C"`, sql`${notes.vaultId}`, noteLinks.startLine)
    .limit(CITATION_ROWS + 1)
  return rows.map(({ updatedAt, ...r }) => ({ ...r, fresh: updatedAt >= file.updatedAt }))
}
