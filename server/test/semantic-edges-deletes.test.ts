// #1015 (ADR-004 §1.3, #1007): after a delete the stored semantic edges are those of an instance that never had
// the node. Each case builds world A, which has the node and then loses it (a purge, a trash, a file gone in a
// sync, a repository or vault deleted, a vault transferred), and world B, built without it; each world's stored
// rows, named by their ends' container and path, must be the same rows with the same similarities, as in
// `semantic-edges-order.test.ts`. A node that held the removed one has its (K+1)-th neighbour in B.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { notes, repositories, repositoryFiles, vaults } from '../src/db/schema.js'
import { createNote, purgeNote, restoreNote, softDeleteNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { runSemanticEdgeRebuild } from '../src/search/semantic-edges.js'
import { purgeVaultRecord } from '../src/vaults/routes.js'
import { config } from '../src/config.js'
import { createActiveUser, loginCookie } from './helpers.js'

const K = config.semanticK
const CORE = 'upload chunk checksum retry resume manifest'
/** `count` words only this node has: the more, the farther it is from the hub. */
const own = (prefix: string, count: number) => Array.from({ length: count }, (_, j) => `${prefix}w${j}`).join(' ')

/** The hub and K + 1 notes near it, each farther than the one before: the hub's list is full and has a (K+1)-th. */
const NOTES: Array<{ path: string; body: string }> = [
  { path: 'notes/hub', body: `${CORE}\n` },
  ...Array.from({ length: K + 1 }, (_, i) => ({ path: `notes/n${i + 1}`, body: `${CORE} ${own(`n${i + 1}`, i + 1)}\n` })),
]
/** K + 2 files of the same vocabulary (a comment), so notes and files hold each other. */
const FILES: Array<{ path: string; content: string }> = Array.from({ length: K + 2 }, (_, i) => ({
  path: `src/f${i + 1}.ts`,
  content: `// ${CORE} ${own(`f${i + 1}`, i + 1)}\n`,
}))
/** Among the hub's K nearest, each held by notes and files. */
const VICTIM_NOTE = 'notes/n2'
const VICTIM_FILE = 'src/f2.ts'

let app: FastifyInstance
const userIds: string[] = []

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  if (userIds.length > 0) {
    await db.delete(vaults).where(inArray(vaults.ownerId, userIds))
    await db.delete(repositories).where(inArray(repositories.ownerId, userIds))
  }
  await app.close()
})

async function owner() {
  const user = await createActiveUser()
  userIds.push(user.id)
  return user
}

// Each container is embedded before the next is added: a note embedding while a file is extracted can leave a
// list that a recompute changes (#1027), which is not what these tests compare.
async function addVault(ownerId: string, without: string[] = []): Promise<string> {
  const [vault] = await db.insert(vaults).values({ name: 'deletes-vault', ownerId }).returning({ id: vaults.id })
  for (const n of NOTES) if (!without.includes(n.path)) await createNote(vault!.id, n)
  await settle()
  return vault!.id
}

async function addRepository(ownerId: string, name: string, without: string[] = []): Promise<string> {
  const [repo] = await db.insert(repositories).values({ name, ownerId, ingestionMethod: 'agent_push' }).returning({ id: repositories.id })
  const files = FILES.filter((f) => !without.includes(f.path))
  await syncRepositoryFiles(repo!.id, files, files.map((f) => f.path))
  await settle()
  return repo!.id
}

/** Every pending embed, extraction and semantic-edge job, run. */
async function settle(): Promise<void> {
  await flushExtraction()
  await flushEmbeddings()
  await runSemanticEdgeRebuild()
}

/**
 * Every stored row whose source is in these containers, as `type:container/path → type:container/path similarity`,
 * sorted; a target that no longer exists is `gone`. A note in the trash is named like a live one: its rows count.
 */
async function storedRows(containerIds: string[]): Promise<string[]> {
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
async function rowsTouching(ids: string[]): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM semantic_edges WHERE node_a_id = ANY(${`{${ids.join(',')}}`}::uuid[]) OR node_b_id = ANY(${`{${ids.join(',')}}`}::uuid[])`)) as unknown as unknown[]
  return rows.length
}

async function noteId(vaultId: string, path: string): Promise<string> {
  const [row] = await db.select({ id: notes.id }).from(notes).where(and(eq(notes.vaultId, vaultId), eq(notes.path, path)))
  return row!.id
}

async function fileIds(repositoryId: string): Promise<string[]> {
  return (await db.select({ id: repositoryFiles.id }).from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repositoryId))).map((r) => r.id)
}

/** A vault and a repository of one owner, all embedded. */
async function world(without: string[] = []): Promise<{ vaultId: string; repositoryId: string }> {
  const user = await owner()
  const vaultId = await addVault(user.id, without)
  const repositoryId = await addRepository(user.id, 'deletes-repo', without)
  await settle()
  return { vaultId, repositoryId }
}

describe('a delete leaves the stored semantic edges of a world that never had the node (#1015)', () => {
  let full: string[]

  beforeAll(async () => {
    const w = await world()
    full = await storedRows([w.vaultId, w.repositoryId])
  }, 120_000)

  it('the fixture: the hub holds K rows, one of them the victim note, files hold notes and the victim file', () => {
    const hub = full.filter((r) => r.startsWith('note:deletes-vault/notes/hub →'))
    expect(hub).toHaveLength(K)
    expect(hub.some((r) => r.includes(`→ note:deletes-vault/${VICTIM_NOTE} `))).toBe(true)
    expect(full.some((r) => r.startsWith('code:') && r.includes(`→ note:deletes-vault/${VICTIM_NOTE} `))).toBe(true)
    expect(full.some((r) => r.startsWith('code:') && r.includes(`→ code:deletes-repo/${VICTIM_FILE} `))).toBe(true)
    expect(full.some((r) => r.startsWith('note:') && r.includes(`→ code:deletes-repo/${VICTIM_FILE} `))).toBe(true)
  })

  it('purge (the repro): the hub keeps K rows, those of a world without the note', async () => {
    const a = await world()
    const id = await noteId(a.vaultId, VICTIM_NOTE)
    expect(await softDeleteNote(a.vaultId, VICTIM_NOTE)).not.toBeNull()
    expect(await purgeNote(a.vaultId, id)).toBe(true)
    await settle()
    const b = await world([VICTIM_NOTE])
    const rows = await storedRows([a.vaultId, a.repositoryId])
    expect(rows.filter((r) => r.startsWith('note:deletes-vault/notes/hub →'))).toHaveLength(K)
    expect(rows).toEqual(await storedRows([b.vaultId, b.repositoryId]))
    expect(await rowsTouching([id])).toBe(0)
  }, 120_000)

  it('trash: the note keeps no rows and leaves every list, as if it never existed', async () => {
    const a = await world()
    const id = await noteId(a.vaultId, VICTIM_NOTE)
    expect(await softDeleteNote(a.vaultId, VICTIM_NOTE)).not.toBeNull()
    await settle()
    const b = await world([VICTIM_NOTE])
    expect(await storedRows([a.vaultId, a.repositoryId])).toEqual(await storedRows([b.vaultId, b.repositoryId]))
    expect(await rowsTouching([id])).toBe(0)
  }, 120_000)

  it('restore from the trash: the rows of a world that never trashed it', async () => {
    const a = await world()
    const id = await noteId(a.vaultId, VICTIM_NOTE)
    expect(await softDeleteNote(a.vaultId, VICTIM_NOTE)).not.toBeNull()
    await settle()
    expect(await restoreNote(a.vaultId, id)).not.toBeNull()
    await settle()
    expect(await storedRows([a.vaultId, a.repositoryId])).toEqual(full)
  }, 120_000)

  it('a file removed by a sync: the rows of a world without the file', async () => {
    const a = await world()
    const before = await fileIds(a.repositoryId)
    const rest = FILES.filter((f) => f.path !== VICTIM_FILE).map((f) => f.path)
    expect((await syncRepositoryFiles(a.repositoryId, [], rest)).deleted).toBe(1)
    await settle()
    const b = await world([VICTIM_FILE])
    expect(await storedRows([a.vaultId, a.repositoryId])).toEqual(await storedRows([b.vaultId, b.repositoryId]))
    const left = new Set(await fileIds(a.repositoryId))
    expect(await rowsTouching(before.filter((id) => !left.has(id)))).toBe(0)
  }, 120_000)

  it('a repository deleted: the vault keeps the rows of a world that never had it', async () => {
    const user = await owner()
    const vaultId = await addVault(user.id)
    const repositoryId = await addRepository(user.id, 'deletes-repo')
    await settle()
    const files = await fileIds(repositoryId)
    const res = await app.inject({ method: 'DELETE', url: `/api/repositories/${repositoryId}`, headers: { cookie: await loginCookie(app, user.email) } })
    expect(res.statusCode).toBe(200)
    await settle()
    const other = await owner()
    const b = await addVault(other.id)
    await settle()
    expect(await storedRows([vaultId])).toEqual(await storedRows([b]))
    expect(await rowsTouching(files)).toBe(0)
  }, 120_000)

  it('a vault purged: the repository keeps the rows of a world that never had it', async () => {
    const a = await world()
    const ids = (await db.select({ id: notes.id }).from(notes).where(eq(notes.vaultId, a.vaultId))).map((r) => r.id)
    await purgeVaultRecord(a.vaultId)
    await settle()
    const other = await owner()
    const b = await addRepository(other.id, 'deletes-repo')
    await settle()
    expect(await storedRows([a.repositoryId])).toEqual(await storedRows([b]))
    expect(await rowsTouching(ids)).toBe(0)
  }, 120_000)

  it("a vault transferred: the rows of a world where the new owner always had it (#999's scope)", async () => {
    // A: the first owner has the vault and repository r1, the second r2; the vault moves to the second.
    const [first, second] = [await owner(), await owner()]
    const vaultId = await addVault(first.id)
    const r1 = await addRepository(first.id, 'deletes-r1')
    const r2 = await addRepository(second.id, 'deletes-r2')
    await settle()
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/transfer`,
      headers: { cookie: await loginCookie(app, first.email) },
      body: { newOwnerId: second.id },
    })
    expect(res.statusCode).toBe(200)
    await settle()
    // B: r1 alone with the first owner, the vault and r2 with the second from the start.
    const [firstB, secondB] = [await owner(), await owner()]
    const r1B = await addRepository(firstB.id, 'deletes-r1')
    const vaultB = await addVault(secondB.id)
    const r2B = await addRepository(secondB.id, 'deletes-r2')
    await settle()
    const rowsB = await storedRows([vaultB, r1B, r2B])
    expect(rowsB.some((r) => r.startsWith('code:deletes-r2/') && r.includes('→ note:'))).toBe(true)
    expect(await storedRows([vaultId, r1, r2])).toEqual(rowsB)
  }, 180_000)
})
