import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, repositoryFiles } from '../src/db/schema.js'
import { computeTreeHash, syncRepositoryFiles } from '../src/repositories/store.js'
import { createActiveUser } from './helpers.js'

// #471 (ADR-004 §2.9): `tree_hash` names the indexed files of any repository.
// Each sync computes it from the rows it already holds plus its own batch;
// migration 0040 backfills it in SQL. All three must agree.

async function makeRepo() {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'tree-hash-test', ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning()
  return repo!.id
}

async function storedTree(repositoryId: string): Promise<string | null> {
  return (await db.select({ treeHash: repositories.treeHash }).from(repositories).where(eq(repositories.id, repositoryId)))[0]!.treeHash
}

/** The tree hash recomputed from every stored row: what an incremental sync must equal. */
async function treeOfRows(repositoryId: string): Promise<string> {
  const rows = await db
    .select({ path: repositoryFiles.path, contentHash: repositoryFiles.contentHash })
    .from(repositoryFiles)
    .where(eq(repositoryFiles.repositoryId, repositoryId))
  return computeTreeHash(new Map(rows.map((r) => [r.path, r.contentHash])))
}

// Code-unit order (JS sort) and byte order (Postgres COLLATE "C") disagree on
// U+FF5E vs an astral character; '-' < '/' tests a path that prefixes another.
const PATHS = ['a/\uFF5E.ts', 'a/\u{1F600}.ts', 'a-b.ts', 'a/b.ts', 'a.ts', 'z.ts']

describe('computeTreeHash', () => {
  it('is 16 hex, independent of insertion order, and moves with any path or hash', () => {
    const entries = PATHS.map((p, i) => [p, `h${i}`] as const)
    const tree = computeTreeHash(new Map(entries))
    expect(tree).toMatch(/^[0-9a-f]{16}$/)
    expect(computeTreeHash(new Map([...entries].reverse()))).toBe(tree)
    expect(computeTreeHash(new Map(entries.map(([p, h], i) => [p, i === 2 ? 'other' : h])))).not.toBe(tree)
    expect(computeTreeHash(new Map(entries.slice(1)))).not.toBe(tree)
  })
})

describe('sync writes the tree hash incrementally', () => {
  it('equals a full recompute after creates, updates, deletes and a no-op', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(repo, PATHS.map((path) => ({ path, content: `// ${path}` })), PATHS)
    const first = await storedTree(repo)
    expect(first).toBe(await treeOfRows(repo))

    await syncRepositoryFiles(repo, [{ path: 'a.ts', content: 'changed' }], PATHS)
    const updated = await storedTree(repo)
    expect(updated).not.toBe(first)
    expect(updated).toBe(await treeOfRows(repo))

    await syncRepositoryFiles(repo, [], PATHS.filter((p) => p !== 'z.ts'))
    const deleted = await storedTree(repo)
    expect(deleted).not.toBe(updated)
    expect(deleted).toBe(await treeOfRows(repo))

    await syncRepositoryFiles(repo, [], PATHS.filter((p) => p !== 'z.ts'))
    expect(await storedTree(repo)).toBe(deleted)

    // A batch file outside currentPaths: stored while nothing else is deleted (as before #471).
    await syncRepositoryFiles(repo, [{ path: 'stray.ts', content: 'x' }], PATHS.filter((p) => p !== 'z.ts'))
    expect(await storedTree(repo)).toBe(await treeOfRows(repo))
  })

  /** Migration 0040's two UPDATEs, narrowed to one repository. */
  async function backfill(repositoryId: string): Promise<void> {
    await db.update(repositories).set({ treeHash: null }).where(eq(repositories.id, repositoryId))
    const migration = await readFile(new URL('../drizzle/0040_repository_tree_hash.sql', import.meta.url), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint').slice(1)) {
      await db.execute(sql.raw(statement.trim().replace(/;$/, ` AND r."id" = '${repositoryId}'`)))
    }
  }

  it("migration 0040's backfill computes the same value", async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(repo, PATHS.map((path) => ({ path, content: `// ${path}` })), PATHS)
    const synced = await storedTree(repo)
    await backfill(repo)
    expect(await storedTree(repo)).toBe(synced)
  })

  it('an empty repository: a sync and the backfill both give the tree of no files; never synced stays null', async () => {
    const repo = await makeRepo()
    await backfill(repo)
    expect(await storedTree(repo)).toBeNull()
    await syncRepositoryFiles(repo, [], [])
    const synced = await storedTree(repo)
    expect(synced).toBe(computeTreeHash(new Map()))
    expect(synced).toBe('e3b0c44298fc1c14')
    await db.update(repositories).set({ lastSyncedAt: new Date() }).where(eq(repositories.id, repo))
    await backfill(repo)
    expect(await storedTree(repo)).toBe(synced)
  })
})
