import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../src/db/client.js'
import { blocks, notes, repositories, repositoryFiles, semanticEdges, vaults } from '../src/db/schema.js'
import { recomputeSemanticEdges, type SemanticNodeType } from '../src/search/semantic-edges.js'
import { createActiveUser } from './helpers.js'

/** Dense 384-d normalized unit vector — avoids HNSW tie-breaking artifacts (#123). */
function denseVector(seed: number): number[] {
  const raw = Array.from({ length: 384 }, (_, i) => Math.sin(seed + i * 0.1))
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0))
  return raw.map((v) => v / norm)
}

/** A note whose blocks carry these vectors (one `section` block each; ADR-004 §2.5). */
async function createNote(vaultId: string, name: string, ...embeddings: number[][]): Promise<string> {
  const [row] = await db
    .insert(notes)
    .values({
      vaultId,
      type: 'notes',
      name,
      path: `notes/${name}.md`,
      frontmatter: { type: 'notes' },
      body: name,
    })
    .returning({ id: notes.id })
  await db.insert(blocks).values(
    embeddings.map((embedding, i) => ({
      ownerType: 'note' as const,
      ownerId: row!.id,
      containerId: vaultId,
      blockId: `b_test${i}`,
      kind: 'section',
      innerPath: `S${i}`,
      startLine: i + 1,
      endLine: i + 1,
      contentHash: 'test',
      ownerVersion: '1',
      embedKey: `test${i}`,
      embedding,
    })),
  )
  return row!.id
}

function edgesOwnedBy(nodeId: string) {
  return db
    .select()
    .from(semanticEdges)
    .where(and(eq(semanticEdges.sourceType, 'note'), eq(semanticEdges.sourceId, nodeId)))
}

/** Notes with one `section` block each, in two inserts (a crowd of them is cheap). */
async function createNotes(vaultId: string, prefix: string, embeddings: number[][]): Promise<string[]> {
  const rows = await db
    .insert(notes)
    .values(embeddings.map((_, i) => ({ vaultId, type: 'notes', name: `${prefix}-${i}`, path: `notes/${prefix}-${i}.md`, frontmatter: { type: 'notes' }, body: prefix })))
    .returning({ id: notes.id })
  await db.insert(blocks).values(
    rows.map((row, i) => ({
      ownerType: 'note' as const,
      ownerId: row.id,
      containerId: vaultId,
      blockId: 'b_test0',
      kind: 'section',
      innerPath: 'S0',
      startLine: 1,
      endLine: 1,
      contentHash: 'test',
      ownerVersion: '1',
      embedKey: 'test0',
      embedding: embeddings[i]!,
    })),
  )
  return rows.map((r) => r.id)
}

/** A repository file whose file-level block carries this vector (the one its semantic edges query with). */
async function createFile(repositoryId: string, path: string, embedding: number[]): Promise<string> {
  const [row] = await db
    .insert(repositoryFiles)
    .values({ repositoryId, path, content: path, contentHash: path, size: path.length })
    .returning({ id: repositoryFiles.id })
  await db.insert(blocks).values({
    ownerType: 'code',
    ownerId: row!.id,
    containerId: repositoryId,
    blockId: 'b_file',
    kind: 'file',
    innerPath: '',
    startLine: 1,
    endLine: 1,
    contentHash: 'test',
    ownerVersion: path,
    embedKey: 'test',
    embedding,
  })
  return row!.id
}

/** `type:id` of every target a node's own edges name. */
async function targetsOf(type: SemanticNodeType, id: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(semanticEdges)
    .where(and(eq(semanticEdges.sourceType, type), eq(semanticEdges.sourceId, id)))
  return rows.map((e) => `${e.targetType}:${e.targetId}`).sort()
}

const keys = (type: SemanticNodeType, ...ids: string[]) => ids.map((id) => `${type}:${id}`)

let vaultId: string
let noteA: string
let noteB: string
const embeddingA = denseVector(1)

beforeAll(async () => {
  const owner = await createActiveUser()
  const [vault] = await db
    .insert(vaults)
    .values({ name: 'Semantic edges vault', ownerId: owner.id })
    .returning({ id: vaults.id })
  vaultId = vault!.id
  // Same dense vector => cosine similarity 1, so each is comfortably in the other's top-k.
  noteA = await createNote(vaultId, `sem-a-${randomUUID()}`, embeddingA)
  noteB = await createNote(vaultId, `sem-b-${randomUUID()}`, denseVector(1))
})

// Row-only fixtures (no note files): delete the vault so the CI
// vault-invariant gate (#578) never sees notes the store did not write.
afterAll(async () => {
  await db.delete(vaults).where(eq(vaults.id, vaultId))
})

describe('recomputeSemanticEdges', () => {
  it('keeps edges another node owns (#91)', async () => {
    // An edge B owns: B holds A in its top-k. Recomputing A must not touch it.
    await db
      .insert(semanticEdges)
      .values({
        sourceType: 'note',
        sourceId: noteB,
        targetType: 'note',
        targetId: noteA,
        similarity: 0.99,
      })
      .onConflictDoNothing()

    await recomputeSemanticEdges('note', noteA, [embeddingA])

    const survivors = await db
      .select()
      .from(semanticEdges)
      .where(and(eq(semanticEdges.sourceId, noteB), eq(semanticEdges.targetId, noteA)))
    expect(survivors).toHaveLength(1)
  })

  it('replaces the edges it owns', async () => {
    const stale = randomUUID()
    await db.insert(semanticEdges).values({
      sourceType: 'note',
      sourceId: noteA,
      targetType: 'note',
      targetId: stale,
      similarity: 0.9,
    })

    await recomputeSemanticEdges('note', noteA, [embeddingA])

    const own = await edgesOwnedBy(noteA)
    expect(own.some((e) => e.targetId === stale)).toBe(false)
  })

  it('writes its rows source-first', async () => {
    await recomputeSemanticEdges('note', noteA, [embeddingA])

    const own = await edgesOwnedBy(noteA)
    expect(own.length).toBeGreaterThan(0)
    expect(own.every((e) => e.sourceType === 'note' && e.sourceId === noteA)).toBe(true)
    expect(own.some((e) => e.targetId === noteB)).toBe(true)
  })

  it('a neighbour note counts once, with its best block; any of the source blocks can find it (#452)', async () => {
    // C: one block far from everything, one equal to D's only block.
    const noteC = await createNote(vaultId, `sem-c-${randomUUID()}`, denseVector(50), denseVector(90))
    const noteD = await createNote(vaultId, `sem-d-${randomUUID()}`, denseVector(90))
    await recomputeSemanticEdges('note', noteD, [denseVector(90)])
    const fromD = (await edgesOwnedBy(noteD)).filter((e) => e.targetId === noteC)
    expect(fromD).toHaveLength(1)
    expect(fromD[0]!.similarity).toBeGreaterThan(0.999)

    await recomputeSemanticEdges('note', noteC, [denseVector(50), denseVector(90)])
    expect((await edgesOwnedBy(noteC)).some((e) => e.targetId === noteD && e.similarity > 0.999)).toBe(true)
  })
})

// D10 (#930, ADR-004): a note's note neighbours come from its vault, a file's code neighbours from its
// repository, and note↔code edges join only resources of one owner. The fixtures are near-identical across
// containers, so an unfiltered lookup fills the slots from the other containers (#461). Each test has its own
// owners, so no other test's resources are in reach of its cross-type leg.
describe('semantic neighbours stay within their vault or repository (#461)', () => {
  const seed = denseVector(300)
  const near = denseVector(300.2)
  const vaultIds: string[] = []
  const repositoryIds: string[] = []

  /** Two fresh owners. */
  async function owners(): Promise<[string, string]> {
    return [(await createActiveUser()).id, (await createActiveUser()).id]
  }

  async function vault(ownerId: string): Promise<string> {
    const [row] = await db.insert(vaults).values({ name: `tenant-${randomUUID()}`, ownerId }).returning({ id: vaults.id })
    vaultIds.push(row!.id)
    return row!.id
  }
  async function repository(ownerId: string): Promise<string> {
    const [row] = await db
      .insert(repositories)
      .values({ name: `tenant-${randomUUID()}`, ownerId, ingestionMethod: 'agent_push' })
      .returning({ id: repositories.id })
    repositoryIds.push(row!.id)
    return row!.id
  }

  afterAll(async () => {
    if (vaultIds.length > 0) await db.delete(vaults).where(inArray(vaults.id, vaultIds))
    if (repositoryIds.length > 0) await db.delete(repositories).where(inArray(repositories.id, repositoryIds))
  })

  it('two vaults (of one owner, and of another) with near-identical notes: no edge crosses vaults', async () => {
    const [ownerA, ownerB] = await owners()
    const [a1, a2, b1] = [await vault(ownerA), await vault(ownerA), await vault(ownerB)]
    const [n1, n1b] = await createNotes(a1, `t-a1-${randomUUID()}`, [seed, near])
    const [n2] = await createNotes(a2, `t-a2-${randomUUID()}`, [seed])
    const [n3] = await createNotes(b1, `t-b1-${randomUUID()}`, [seed])

    for (const [id, expected] of [
      [n1!, keys('note', n1b!)],
      [n2!, []],
      [n3!, []],
    ] as const) {
      await recomputeSemanticEdges('note', id, [seed])
      expect(await targetsOf('note', id)).toEqual([...expected].sort())
    }
  })

  it('two repositories (of one owner, and of another) with near-identical files: no edge crosses repositories', async () => {
    const [ownerA, ownerB] = await owners()
    const [r1, r2, r3] = [await repository(ownerA), await repository(ownerA), await repository(ownerB)]
    const f1 = await createFile(r1, 'src/a.ts', seed)
    const f1b = await createFile(r1, 'src/b.ts', near)
    const f2 = await createFile(r2, 'src/a.ts', seed)
    const f3 = await createFile(r3, 'src/a.ts', seed)

    for (const [id, expected] of [
      [f1, keys('code', f1b)],
      [f2, []],
      [f3, []],
    ] as const) {
      await recomputeSemanticEdges('code', id, [seed])
      expect(await targetsOf('code', id)).toEqual([...expected].sort())
    }
  })

  it("note↔code edges join only one owner's vaults and repositories", async () => {
    const [owner, other] = await owners()
    const [mine1, mine2, theirs] = [await vault(owner), await vault(owner), await vault(other)]
    const [repo, theirRepo] = [await repository(owner), await repository(other)]
    const [n1] = await createNotes(mine1, `t-x1-${randomUUID()}`, [seed])
    const [n2] = await createNotes(mine2, `t-x2-${randomUUID()}`, [seed])
    const [n3] = await createNotes(theirs, `t-x3-${randomUUID()}`, [seed])
    const file = await createFile(repo, 'src/x.ts', seed)
    const theirFile = await createFile(theirRepo, 'src/x.ts', seed)

    await recomputeSemanticEdges('code', file, [seed])
    expect(await targetsOf('code', file)).toEqual(keys('note', n1!, n2!).sort())
    await recomputeSemanticEdges('note', n1!, [seed])
    expect(await targetsOf('note', n1!)).toEqual(keys('code', file))
    await recomputeSemanticEdges('note', n3!, [seed])
    expect(await targetsOf('note', n3!)).toEqual(keys('code', theirFile))
  })

  it('a small vault in a big instance still gets its neighbours (the filter applies during the HNSW scan)', async () => {
    // 300 blocks of another vault are all nearer than the small vault's other note (cos ≈ 0.96–1 against ≈ 0.90):
    // more than the 100 an ef_search-bounded scan returns, so a filter after the scan would find nothing.
    const [ownerA, ownerB] = await owners()
    const small = await vault(ownerA)
    const crowd = await vault(ownerB)
    const [s1, s2] = await createNotes(small, `t-small-${randomUUID()}`, [denseVector(400), denseVector(400.45)])
    await createNotes(
      crowd,
      `t-crowd-${randomUUID()}`,
      Array.from({ length: 300 }, (_, k) => denseVector(400 + 0.001 * (k + 1))),
    )

    await recomputeSemanticEdges('note', s1!, [denseVector(400)])
    expect(await targetsOf('note', s1!)).toEqual(keys('note', s2!))
  })
})
