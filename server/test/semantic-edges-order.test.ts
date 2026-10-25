// #1007 (ADR-004 §1.3): the stored semantic edges are a function of the content, not of the order it was
// embedded in. Two accounts hold the same vault and repository:
//  - world A creates the notes in fixture order and pushes the files in one push;
//  - world B creates the notes in reverse, each embedded (and its neighbours found) before the next exists,
//    and pushes the files one at a time in reverse;
//  - every note and file id sorts in fixture order in A and in reverse fixture order in B (`rankedId`), so a
//    tie broken by id gives B another answer.
// Each world's stored rows, named by their ends' paths, must be the same rows with the same similarities.
import type * as Crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { inArray, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { blocks, notes, repositories, repositoryFiles, vaults } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { recomputeSemanticEdges } from '../src/search/semantic-edges.js'
import { config } from '../src/config.js'
import { createActiveUser } from './helpers.js'

// createNote takes its id from `randomUUID()`: the next one is queued here before each call.
const queuedIds = vi.hoisted(() => [] as string[])
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>()
  return { ...actual, randomUUID: () => queuedIds.shift() ?? actual.randomUUID() }
})
const { randomUUID } = await vi.importActual<typeof Crypto>('node:crypto')

/** A fresh id whose first 8 hex digits are `rank`: ids sort by rank (Postgres compares uuids byte by byte). */
function rankedId(rank: number): string {
  return `${rank.toString(16).padStart(8, '0')}${randomUUID().slice(8)}`
}

const NOTES: Array<{ path: string; body: string }> = [
  { path: 'index', body: '# Upload pipeline\n\nHow an upload travels: chunk, checksum, retry and resume.\n' },
  { path: 'guides/retry', body: '# Retry\n\nRetry a failed upload with exponential backoff.\n' },
  { path: 'guides/resume', body: '# Resume\n\nResume an interrupted upload from the last acknowledged chunk.\n' },
  { path: 'twins/a', body: 'Checksum every chunk before the upload starts.\n' },
  { path: 'twins/b', body: 'Checksum every chunk before the upload starts.\n' },
  { path: 'journal/2026-10-01', body: 'Parsed the upload manifest.\n' },
  { path: 'journal/2026-10-02', body: 'Parsed the retry manifest.\n' },
]

const FILES: Array<{ path: string; content: string }> = [
  {
    path: 'src/upload.ts',
    content: [
      "import { checksum } from './checksum'",
      '',
      '/** Uploads one chunk after its checksum. */',
      'export function upload(chunk: string): string {',
      '  return checksum(chunk)',
      '}',
      '',
      'export function parse(manifest: string): string[] {',
      "  return manifest.split('\\n')",
      '}',
      '',
    ].join('\n'),
  },
  { path: 'src/checksum.ts', content: '/** A chunk checksum. */\nexport function checksum(chunk: string): string {\n  return String(chunk.length)\n}\n' },
  {
    path: 'src/retry.ts',
    content: [
      "import { upload } from './upload'",
      '',
      'export class Retrier {',
      '  retry(chunk: string): string { return upload(chunk) }',
      '}',
      '',
      'export function parse(manifest: string): string[] {',
      "  return manifest.split(',')",
      '}',
      '',
    ].join('\n'),
  },
  { path: 'lib/util.py', content: 'def parse(manifest):\n    return manifest.split()\n' },
  { path: 'README.md', content: '# order-repo\n\nUpload, retry and checksum chunks.\n' },
]

const vaultIds: string[] = []
const repositoryIds: string[] = []

/** One account's vault and repository; `reverse`: world B (reverse order, reverse ids, one embed at a time). */
async function buildWorld(reverse: boolean): Promise<{ vaultId: string; repositoryId: string }> {
  const owner = await createActiveUser()
  const [vault] = await db.insert(vaults).values({ name: `order-${reverse ? 'b' : 'a'}`, ownerId: owner.id }).returning({ id: vaults.id })
  const [repository] = await db
    .insert(repositories)
    .values({ name: `order-${reverse ? 'b' : 'a'}`, ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning({ id: repositories.id })
  const vaultId = vault!.id
  const repositoryId = repository!.id
  vaultIds.push(vaultId)
  repositoryIds.push(repositoryId)
  const idAt = (index: number) => rankedId(reverse ? 0xffffffff - index : index)

  for (const n of reverse ? [...NOTES].reverse() : NOTES) {
    const id = idAt(NOTES.indexOf(n))
    queuedIds.push(id)
    const created = await createNote(vaultId, { path: n.path, body: n.body })
    if (created.id !== id || queuedIds.length > 0) throw new Error(`${n.path}: createNote did not take the queued id ${id} (got ${created.id})`)
    if (reverse) await flushEmbeddings()
  }
  // A file's row is inserted empty under its id just before its push, which then fills it: an update keeps the id.
  const placeFile = async (f: (typeof FILES)[number]) => {
    await db.insert(repositoryFiles).values({ id: idAt(FILES.indexOf(f)), repositoryId, path: f.path, content: '', contentHash: '', size: 0 })
  }
  if (reverse) {
    const pushed: string[] = []
    for (const f of [...FILES].reverse()) {
      pushed.push(f.path)
      await placeFile(f)
      await syncRepositoryFiles(repositoryId, [f], [...pushed])
      await flushExtraction()
    }
  } else {
    for (const f of FILES) await placeFile(f)
    await syncRepositoryFiles(repositoryId, FILES, FILES.map((f) => f.path))
  }
  await flushExtraction()
  await flushEmbeddings()
  return { vaultId, repositoryId }
}

/** Every stored row whose source is in these containers, as `type:path → type:path similarity`, sorted. */
async function storedRows(containerIds: string[]): Promise<string[]> {
  const rows = (await db.execute(sql`
    WITH node AS (
      SELECT 'note'::semantic_node_type AS type, id, path, vault_id AS container_id FROM notes
      UNION ALL SELECT 'code'::semantic_node_type, id, path, repository_id FROM repository_files)
    SELECT a.type || ':' || a.path AS source, b.type || ':' || b.path AS target, e.similarity
    FROM semantic_edges e
    JOIN node a ON a.type = e.node_a_type AND a.id = e.node_a_id
    JOIN node b ON b.type = e.node_b_type AND b.id = e.node_b_id
    WHERE a.container_id = ANY(${`{${containerIds.join(',')}}`}::uuid[])`)) as unknown as Array<{ source: string; target: string; similarity: number }>
  return rows.map((r) => `${r.source} → ${r.target} ${r.similarity}`).sort()
}

afterAll(async () => {
  if (vaultIds.length > 0) await db.delete(vaults).where(inArray(vaults.id, vaultIds))
  if (repositoryIds.length > 0) await db.delete(repositories).where(inArray(repositories.id, repositoryIds))
})

describe('semantic edges do not depend on the order nodes were embedded in (#1007)', () => {
  let a: string[]
  let b: string[]

  beforeAll(async () => {
    const worldA = await buildWorld(false)
    const worldB = await buildWorld(true)
    a = await storedRows([worldA.vaultId, worldA.repositoryId])
    b = await storedRows([worldB.vaultId, worldB.repositoryId])
  }, 120_000)

  it('the fixture has edges of every kind (else the comparison proves nothing)', () => {
    for (const kind of [/^note:.* → note:/, /^code:.* → code:/, /^note:.* → code:/, /^code:.* → note:/]) {
      expect(a.some((row) => kind.test(row)), String(kind)).toBe(true)
    }
  })

  it('two accounts with the same notes and files, embedded in opposite orders, store the same rows and similarities', () => {
    expect(b).toEqual(a)
  })
})

describe('a tie in similarity is broken by path, not by id (#1007)', () => {
  /** A vault of `count` notes `tie/<i, two digits>` whose only block is one shared vector, ids ascending (A) or descending (B) with i. */
  async function tieVault(reverse: boolean, count: number): Promise<string> {
    const owner = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: `tie-${reverse ? 'b' : 'a'}`, ownerId: owner.id }).returning({ id: vaults.id })
    vaultIds.push(vault!.id)
    const ids = Array.from({ length: count }, (_, i) => rankedId(reverse ? 0xffffffff - i : i))
    await db.insert(notes).values(
      ids.map((id, i) => ({ id, vaultId: vault!.id, type: 'notes', name: `tie-${i}`, path: `tie/${String(i).padStart(2, '0')}`, frontmatter: { type: 'notes' }, body: 'tie' })),
    )
    const vector = Array.from({ length: 384 }, (_, d) => Math.sin(7 + d * 0.1))
    await db.insert(blocks).values(
      ids.map((id) => ({
        ownerType: 'note' as const,
        ownerId: id,
        containerId: vault!.id,
        blockId: 'b_tie',
        kind: 'section',
        innerPath: 'S0',
        startLine: 1,
        endLine: 1,
        contentHash: 'tie',
        ownerVersion: '1',
        embedKey: 'tie',
        embedding: vector,
      })),
    )
    // Every note exists before any is computed: only the tie decides which neighbours each keeps.
    for (const id of reverse ? [...ids].reverse() : ids) await recomputeSemanticEdges('note', id)
    return vault!.id
  }

  it(`more than SEMANTIC_K equally similar neighbours: both worlds keep the same ${config.semanticK}`, async () => {
    const count = config.semanticK + 3
    const a = await tieVault(false, count)
    const b = await tieVault(true, count)
    const rowsA = await storedRows([a])
    expect(rowsA).toHaveLength(count * config.semanticK)
    // The nearest by path: tie/00 keeps tie/01 … tie/0K.
    expect(rowsA.filter((r) => r.startsWith('note:tie/00 →')).map((r) => r.split(' ')[2])).toEqual(
      Array.from({ length: config.semanticK }, (_, i) => `note:tie/${String(i + 1).padStart(2, '0')}`),
    )
    expect(await storedRows([b])).toEqual(rowsA)
  })
})
