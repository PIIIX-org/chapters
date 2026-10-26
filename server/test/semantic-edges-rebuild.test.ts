// #1007: an instance whose semantic edges were stored before the fix holds each node's top-k among the nodes
// that existed when it was embedded. Re-embedding keeps every vector (same embed keys), so it recomputes
// nothing; the rebuild that `pnpm reindex` runs (and migration 0050 queues once) recomputes every node from
// its stored vectors and gives the edges of the content.
import { afterAll, describe, expect, it } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { blocks, notes, repositories, repositoryFiles, vaults } from '../src/db/schema.js'
import { JOB_PRIORITY } from '../src/jobs/durable.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { enqueueEmbeddings, flushEmbeddings } from '../src/search/embedding-queue.js'
import {
  SEMANTIC_EDGES_JOB,
  enqueueSemanticEdgeRebuild,
  recomputeSemanticEdges,
  runSemanticEdgeRebuild,
  type SemanticNodeType,
} from '../src/search/semantic-edges.js'
import { createActiveUser } from './helpers.js'

const NOTES: Array<{ path: string; body: string }> = [
  { path: 'index', body: '# Upload pipeline\n\nHow an upload travels: chunk, checksum, retry and resume.\n' },
  { path: 'guides/retry', body: '# Retry\n\nRetry a failed upload with exponential backoff.\n' },
  { path: 'guides/resume', body: '# Resume\n\nResume an interrupted upload from the last acknowledged chunk.\n' },
  { path: 'twins/a', body: 'Checksum every chunk before the upload starts.\n' },
  { path: 'journal/2026-10-01', body: 'Parsed the upload manifest.\n' },
]

const FILES: Array<{ path: string; content: string }> = [
  { path: 'src/upload.ts', content: "import { checksum } from './checksum'\n\nexport function upload(chunk: string): string {\n  return checksum(chunk)\n}\n" },
  { path: 'src/checksum.ts', content: '/** A chunk checksum. */\nexport function checksum(chunk: string): string {\n  return String(chunk.length)\n}\n' },
  { path: 'src/retry.ts', content: "import { upload } from './upload'\n\nexport function retry(chunk: string): string {\n  return upload(chunk)\n}\n" },
  { path: 'lib/util.py', content: 'def parse(manifest):\n    return manifest.split()\n' },
]

let vaultId: string | undefined
let repositoryId: string | undefined

afterAll(async () => {
  if (vaultId) await db.delete(vaults).where(eq(vaults.id, vaultId))
  if (repositoryId) await db.delete(repositories).where(eq(repositories.id, repositoryId))
})

/** The stored rows of the fixture's nodes, as `type:path → type:path similarity`, sorted. */
async function storedRows(): Promise<string[]> {
  const rows = (await db.execute(sql`
    WITH node AS (
      SELECT 'note'::semantic_node_type AS type, id, path FROM notes WHERE vault_id = ${vaultId!}
      UNION ALL SELECT 'code'::semantic_node_type, id, path FROM repository_files WHERE repository_id = ${repositoryId!})
    SELECT a.type || ':' || a.path AS source, b.type || ':' || b.path AS target, e.similarity
    FROM semantic_edges e
    JOIN node a ON a.type = e.node_a_type AND a.id = e.node_a_id
    JOIN node b ON b.type = e.node_b_type AND b.id = e.node_b_id`)) as unknown as Array<{ source: string; target: string; similarity: number }>
  return rows.map((r) => `${r.source} → ${r.target} ${r.similarity}`).sort()
}

describe('the reindex rebuild repairs edges stored in embed order (#1007)', () => {
  it('re-embedding leaves them; the rebuild gives the edges of the content', async () => {
    const owner = await createActiveUser()
    vaultId = (await db.insert(vaults).values({ name: 'rebuild', ownerId: owner.id }).returning({ id: vaults.id }))[0]!.id
    repositoryId = (
      await db.insert(repositories).values({ name: 'rebuild', ownerId: owner.id, ingestionMethod: 'agent_push' }).returning({ id: repositories.id })
    )[0]!.id
    const noteIds: string[] = []
    for (const n of NOTES) noteIds.push((await createNote(vaultId, n)).id)
    await syncRepositoryFiles(repositoryId, FILES, FILES.map((f) => f.path))
    await flushExtraction()
    await flushEmbeddings()
    const expected = await storedRows()

    // The instance as the code before the fix stored it: files pushed one at a time in reverse, then the notes
    // in reverse, each node finding its neighbours among the nodes embedded before it. Every vector is
    // hidden, then given back to one node at a time, which recomputes only its own rows.
    const fileIds = new Map(
      (await db.select({ id: repositoryFiles.id, path: repositoryFiles.path }).from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repositoryId))).map(
        (f) => [f.path, f.id],
      ),
    )
    const order: Array<[SemanticNodeType, string]> = [
      ...[...FILES].reverse().map((f): [SemanticNodeType, string] => ['code', fileIds.get(f.path)!]),
      ...[...noteIds].reverse().map((id): [SemanticNodeType, string] => ['note', id]),
    ]
    const vectors = await db
      .select({ id: blocks.id, ownerId: blocks.ownerId, embedding: blocks.embedding })
      .from(blocks)
      .where(inArray(blocks.containerId, [vaultId, repositoryId]))
    await db.update(blocks).set({ embedding: null }).where(inArray(blocks.containerId, [vaultId, repositoryId]))
    for (const [type, id] of order) {
      for (const b of vectors.filter((v) => v.ownerId === id)) await db.update(blocks).set({ embedding: b.embedding }).where(eq(blocks.id, b.id))
      await recomputeSemanticEdges(type, id)
    }
    const stale = await storedRows()
    expect(stale, 'the order changed the stored edges (else this test proves nothing)').not.toEqual(expected)

    // What `pnpm reindex` ran before: every note embedded again. Its vectors are kept, so no edge is recomputed.
    await enqueueEmbeddings(noteIds, 'finished', JOB_PRIORITY.catchUp)
    await flushEmbeddings()
    expect(await storedRows()).toEqual(stale)

    // The rebuild it runs now, for every node of the instance; only this fixture's jobs run here.
    expect(await enqueueSemanticEdgeRebuild('finished')).toBeGreaterThanOrEqual(NOTES.length + FILES.length)
    const mine = [...noteIds, ...fileIds.values()]
    await db.execute(sql`DELETE FROM jobs WHERE kind = ${SEMANTIC_EDGES_JOB} AND done_at IS NULL
      AND NOT (payload->>'nodeId' = ANY(${`{${mine.join(',')}}`}::text[]))`)
    const queued = await db.execute(sql`SELECT 1 FROM jobs WHERE kind = ${SEMANTIC_EDGES_JOB} AND done_at IS NULL`)
    expect(queued).toHaveLength(mine.length)
    await runSemanticEdgeRebuild()
    expect(await storedRows()).toEqual(expected)
    const left = await db.execute(sql`SELECT 1 FROM jobs WHERE kind = ${SEMANTIC_EDGES_JOB} AND (done_at IS NULL OR last_error IS NOT NULL)`)
    expect(left).toHaveLength(0)
    // A trashed note gets no rebuild job.
    await db.update(notes).set({ deletedAt: new Date() }).where(and(eq(notes.id, noteIds[0]!), eq(notes.vaultId, vaultId)))
    await db.execute(sql`DELETE FROM jobs WHERE kind = ${SEMANTIC_EDGES_JOB}`)
    await enqueueSemanticEdgeRebuild('never')
    expect(await db.execute(sql`SELECT 1 FROM jobs WHERE kind = ${SEMANTIC_EDGES_JOB} AND payload->>'nodeId' = ${noteIds[0]!}`)).toHaveLength(0)
    await db.execute(sql`DELETE FROM jobs WHERE kind = ${SEMANTIC_EDGES_JOB}`)
  }, 60_000)
})
