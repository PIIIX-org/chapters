// The world of the semantic-edge delete and race tests (#1015, #1025, #1026, #1027): a vault and a repository of one
// owner whose notes and files share a vocabulary, so notes and files hold each other. Rows are compared by their
// ends' container and path, as in `semantic-edges-order.test.ts`.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { notes, repositories, repositoryFiles, vaults } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { runSemanticEdgeRebuild } from '../src/search/semantic-edges.js'
import { config } from '../src/config.js'
import { createActiveUser } from './helpers.js'

export const K = config.semanticK
const CORE = 'upload chunk checksum retry resume manifest'
/** `count` words only this node has: the more, the farther it is from the hub. */
const own = (prefix: string, count: number) => Array.from({ length: count }, (_, j) => `${prefix}w${j}`).join(' ')

/** The hub and K + 1 notes near it, each farther than the one before: the hub's list is full and has a (K+1)-th. */
export const NOTES: Array<{ path: string; body: string }> = [
  { path: 'notes/hub', body: `${CORE}\n` },
  ...Array.from({ length: K + 1 }, (_, i) => ({ path: `notes/n${i + 1}`, body: `${CORE} ${own(`n${i + 1}`, i + 1)}\n` })),
]
/** K + 2 files of the same vocabulary (a comment), so notes and files hold each other. */
export const FILES: Array<{ path: string; content: string }> = Array.from({ length: K + 2 }, (_, i) => ({
  path: `src/f${i + 1}.ts`,
  content: `// ${CORE} ${own(`f${i + 1}`, i + 1)}\n`,
}))
/** Among the hub's K nearest, each held by notes and files. */
export const VICTIM_NOTE = 'notes/n2'
export const VICTIM_FILE = 'src/f2.ts'

const userIds: string[] = []

export async function owner() {
  const user = await createActiveUser()
  userIds.push(user.id)
  return user
}

/** Deletes every vault and repository of the owners made here. */
export async function cleanup(): Promise<void> {
  if (userIds.length === 0) return
  await db.delete(vaults).where(inArray(vaults.ownerId, userIds))
  await db.delete(repositories).where(inArray(repositories.ownerId, userIds))
}

// Each container is embedded before the next is added, so the worlds compared do not depend on how the embeds of
// notes and files interleave (#1027 has its own tests: `semantic-edges-races.test.ts`).
export async function addVault(ownerId: string, without: string[] = []): Promise<string> {
  const [vault] = await db.insert(vaults).values({ name: 'deletes-vault', ownerId }).returning({ id: vaults.id })
  for (const n of NOTES) if (!without.includes(n.path)) await createNote(vault!.id, n)
  await settle()
  return vault!.id
}

export async function addRepository(ownerId: string, name: string, without: string[] = []): Promise<string> {
  const [repo] = await db.insert(repositories).values({ name, ownerId, ingestionMethod: 'agent_push' }).returning({ id: repositories.id })
  const files = FILES.filter((f) => !without.includes(f.path))
  await syncRepositoryFiles(repo!.id, files, files.map((f) => f.path))
  await settle()
  return repo!.id
}

/** Every pending embed, extraction and semantic-edge job, run. */
export async function settle(): Promise<void> {
  await flushExtraction()
  await flushEmbeddings()
  await runSemanticEdgeRebuild()
}

/**
 * Every stored row whose source is in these containers, as `type:container/path → type:container/path similarity`,
 * sorted; a target that no longer exists is `gone`. A note in the trash is named like a live one: its rows count.
 */
export async function storedRows(containerIds: string[]): Promise<string[]> {
  const rows = (await db.execute(sql`
    WITH node AS (
      SELECT 'note'::semantic_node_type AS type, n.id, n.path, v.name AS container, n.vault_id AS container_id
      FROM notes n JOIN vaults v ON v.id = n.vault_id
      UNION ALL SELECT 'code'::semantic_node_type, f.id, f.path, r.name, f.repository_id
      FROM repository_files f JOIN repositories r ON r.id = f.repository_id)
    SELECT a.type || ':' || a.container || '/' || a.path AS source,
      coalesce(b.type || ':' || b.container || '/' || b.path, 'gone') AS target, e.similarity
    FROM semantic_edges e
    JOIN node a ON a.type = e.node_a_type AND a.id = e.node_a_id
    LEFT JOIN node b ON b.type = e.node_b_type AND b.id = e.node_b_id
    WHERE a.container_id = ANY(${`{${containerIds.join(',')}}`}::uuid[])`)) as unknown as Array<{
    source: string
    target: string
    similarity: number
  }>
  return rows.map((r) => `${r.source} → ${r.target} ${r.similarity}`).sort()
}

/** Rows naming any of `ids` at either end (rows of nodes outside every container too). */
export async function rowsTouching(ids: string[]): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM semantic_edges WHERE node_a_id = ANY(${`{${ids.join(',')}}`}::uuid[]) OR node_b_id = ANY(${`{${ids.join(',')}}`}::uuid[])`)) as unknown as unknown[]
  return rows.length
}

export async function noteId(vaultId: string, path: string): Promise<string> {
  const [row] = await db.select({ id: notes.id }).from(notes).where(and(eq(notes.vaultId, vaultId), eq(notes.path, path)))
  return row!.id
}

export async function fileId(repositoryId: string, path: string): Promise<string> {
  const [row] = await db
    .select({ id: repositoryFiles.id })
    .from(repositoryFiles)
    .where(and(eq(repositoryFiles.repositoryId, repositoryId), eq(repositoryFiles.path, path)))
  return row!.id
}

export async function fileIds(repositoryId: string): Promise<string[]> {
  return (await db.select({ id: repositoryFiles.id }).from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repositoryId))).map((r) => r.id)
}

/** A vault and a repository of one owner, all embedded. */
export async function world(without: string[] = []): Promise<{ vaultId: string; repositoryId: string }> {
  const user = await owner()
  const vaultId = await addVault(user.id, without)
  const repositoryId = await addRepository(user.id, 'deletes-repo', without)
  await settle()
  return { vaultId, repositoryId }
}
