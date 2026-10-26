// #1007 review round 1: what keeping every node's top-k current costs per embed, and that a refresh failing
// after its write committed is not lost; #1015: per delete. `setHnswScan` runs once per recompute of a node's
// edges and once per search for the nodes an embed enters (search/semantic-edges.ts), so its calls count the work.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, repositoryFiles, semanticEdges } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { SEMANTIC_EDGES_JOB, recomputeSemanticEdges, runSemanticEdgeRebuild } from '../src/search/semantic-edges.js'
import type * as Hnsw from '../src/search/hnsw.js'
import { config } from '../src/config.js'
import { createActiveUser } from './helpers.js'

const scans = vi.hoisted(() => ({ calls: 0, fail: 0 }))
vi.mock('../src/search/hnsw.js', async (importOriginal) => {
  const real = await importOriginal<typeof Hnsw>()
  return {
    ...real,
    setHnswScan: async (...args: Parameters<typeof real.setHnswScan>) => {
      scans.calls++
      if (scans.fail > 0) {
        scans.fail--
        throw new Error('injected: the database went away after the commit')
      }
      return real.setHnswScan(...args)
    },
  }
})

const repositoryIds: string[] = []

async function repository(name: string): Promise<string> {
  const owner = await createActiveUser()
  const [row] = await db.insert(repositories).values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' }).returning({ id: repositories.id })
  repositoryIds.push(row!.id)
  return row!.id
}

async function fileId(repositoryId: string, path: string): Promise<string> {
  const [row] = await db
    .select({ id: repositoryFiles.id })
    .from(repositoryFiles)
    .where(and(eq(repositoryFiles.repositoryId, repositoryId), eq(repositoryFiles.path, path)))
  return row!.id
}

afterEach(() => {
  scans.fail = 0
})

afterAll(async () => {
  if (repositoryIds.length > 0) await db.delete(repositories).where(inArray(repositories.id, repositoryIds))
})

/** The stored rows of a repository's files, as `path → path similarity`, sorted. */
async function rowsOf(repositoryId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT a.path AS source, b.path AS target, e.similarity FROM semantic_edges e
    JOIN repository_files a ON a.id = e.node_a_id AND e.node_a_type = 'code'
    JOIN repository_files b ON b.id = e.node_b_id AND e.node_b_type = 'code'
    WHERE a.repository_id = ${repositoryId}`)) as unknown as Array<{ source: string; target: string; similarity: number }>
  return rows.map((r) => `${r.source} → ${r.target} ${r.similarity}`).sort()
}

describe('the cost of an embed (#1007)', () => {
  it('100 files of one content, pushed in path order and in reverse: two scans per file, and the rows of a full recompute', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ path: `pkg${String(i).padStart(3, '0')}/__init__.py`, content: 'def setup():\n    pass\n' }))
    const rows: string[][] = []
    for (const order of [files, [...files].reverse()]) {
      const id = await repository(`identical-${rows.length}`)
      scans.calls = 0
      await syncRepositoryFiles(id, order, order.map((f) => f.path))
      await flushExtraction()
      // One for the search of the lists it enters, one for its own: a file that ties with every earlier one merges into
      // their lists instead of recomputing them (before, about one recompute per earlier file: 5,140 scans in reverse).
      expect(scans.calls).toBeLessThanOrEqual(2 * files.length)
      const incremental = await rowsOf(id)
      expect(incremental.length).toBeGreaterThan(0)
      const ids = await db.select({ id: repositoryFiles.id }).from(repositoryFiles).where(eq(repositoryFiles.repositoryId, id))
      for (const f of ids) await recomputeSemanticEdges('code', f.id)
      expect(await rowsOf(id)).toEqual(incremental)
      rows.push(incremental)
    }
    expect(rows[1]).toEqual(rows[0])
  }, 120_000)
})

describe('the cost of a delete (#1015)', () => {
  it('a sync that removes 100 files queues one recompute per file that held one, and leaves the rows of a full recompute', async () => {
    // Five contents, 24 files each: a file's K neighbours are the first others of its content by path.
    const files = Array.from({ length: 120 }, (_, i) => ({ path: `pkg${String(i).padStart(3, '0')}/mod.py`, content: `def setup${i % 5}():\n    pass\n` }))
    const id = await repository('deletes')
    await syncRepositoryFiles(id, files, files.map((f) => f.path))
    await flushExtraction()
    const kept = files.slice(0, 20)
    const keptIds = await Promise.all(kept.map((f) => fileId(id, f.path)))
    expect((await syncRepositoryFiles(id, [], kept.map((f) => f.path))).deleted).toBe(100)
    // Each of the 20 files left held 5 of the removed ones (its 3 others of one content come first by path): one job each.
    const queued = (await db.execute(sql`
      SELECT payload->>'nodeId' AS id FROM jobs WHERE kind = ${SEMANTIC_EDGES_JOB} AND done_at IS NULL`)) as unknown as Array<{ id: string }>
    expect(queued.map((j) => j.id).sort()).toEqual([...keptIds].sort())
    scans.calls = 0
    await runSemanticEdgeRebuild()
    expect(scans.calls).toBe(kept.length)
    const incremental = await rowsOf(id)
    // The 3 others of its content, then K - 3 of the other contents.
    expect(incremental).toHaveLength(kept.length * config.semanticK)
    for (const f of keptIds) await recomputeSemanticEdges('code', f)
    expect(await rowsOf(id)).toEqual(incremental)
  }, 120_000)
})

describe('a refresh that fails after its write committed runs again (#1007)', () => {
  it('the job stays, and the worker runs it once its lease ends', async () => {
    const id = await repository('retry')
    await syncRepositoryFiles(id, [{ path: 'src/a.ts', content: 'export const upload = 1\n' }], ['src/a.ts'])
    await flushExtraction()
    scans.fail = 1
    await syncRepositoryFiles(id, [{ path: 'src/b.ts', content: 'export const upload = 2\n' }], ['src/a.ts', 'src/b.ts'])
    await flushExtraction()
    const b = await fileId(id, 'src/b.ts')
    const own = () => db.select().from(semanticEdges).where(eq(semanticEdges.sourceId, b))
    const pending = () => db.execute(sql`SELECT 1 FROM jobs WHERE kind = ${SEMANTIC_EDGES_JOB} AND done_at IS NULL AND payload->>'nodeId' = ${b}`)
    expect(await own()).toHaveLength(0)
    expect(await pending()).toHaveLength(1)

    // The lease the write took for its own run ends (a minute in production).
    await db.execute(sql`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE kind = ${SEMANTIC_EDGES_JOB} AND done_at IS NULL AND payload->>'nodeId' = ${b}`)
    await runSemanticEdgeRebuild()
    expect((await own()).map((e) => e.targetId)).toContain(await fileId(id, 'src/a.ts'))
    expect(await pending()).toHaveLength(0)
  })
})
