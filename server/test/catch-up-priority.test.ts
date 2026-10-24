// #453 review: boot catch-up can queue every file and note of an instance
// (a version bump, an upgrade). A write made meanwhile (a new or edited note,
// a push) must not wait behind that backlog: its job is served before the
// catch-up jobs still queued. Uses only entry points that existed before
// (the fails-before job runs this file against the base source).
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { blocks, notes, repositories, repositoryFiles, vaults } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { extractionWork, flushExtraction, scheduleMissingExtractions } from '../src/repositories/extraction-queue.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushEmbeddings, scheduleMissingEmbeddings } from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { createActiveUser } from './helpers.js'

const BACKLOG = 5

afterEach(() => {
  vi.restoreAllMocks()
})

describe('writes are served before the boot catch-up backlog (#453)', () => {
  it('a push during the extraction catch-up is extracted before the backlog of its repository', async () => {
    const owner = await createActiveUser()
    const [repo] = await db
      .insert(repositories)
      .values({ name: 'catch-up-priority', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()
    // Files persisted by a sync whose extraction never ran: the catch-up queues them.
    const paths = Array.from({ length: BACKLOG }, (_, i) => `backlog/f${i}.txt`)
    const rows = await db
      .insert(repositoryFiles)
      .values(
        paths.map((path) => ({
          repositoryId: repo!.id,
          path,
          content: path,
          contentHash: createHash('sha256').update(path).digest('hex'),
          size: path.length,
        })),
      )
      .returning({ id: repositoryFiles.id, path: repositoryFiles.path })
    const pathById = new Map(rows.map((r) => [r.id, r.path]))

    // The first claimed job is held until the push is queued, so the order depends only on the queue.
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const order: string[] = []
    vi.spyOn(extractionWork, 'processFile').mockImplementation(async (fileId) => {
      await gate
      const [row] = await db.select({ path: repositoryFiles.path }).from(repositoryFiles).where(eq(repositoryFiles.id, fileId))
      if (row && (pathById.has(fileId) || row.path === 'pushed.ts')) order.push(row.path)
    })

    expect(await scheduleMissingExtractions()).toBeGreaterThanOrEqual(BACKLOG)
    await syncRepositoryFiles(repo!.id, [{ path: 'pushed.ts', content: 'export const pushed = 1\n' }], [...paths, 'pushed.ts'])
    release()
    await flushExtraction()

    expect(order).toHaveLength(BACKLOG + 1)
    // At most the one catch-up job already running when the push came is served before it.
    expect(order.indexOf('pushed.ts')).toBeLessThanOrEqual(1)
  })

  it('a note written during the embedding catch-up is embedded before the backlog', async () => {
    const user = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: 'catch-up-priority-vault', ownerId: user.id }).returning()
    try {
      const stamp = Date.now()
      // Notes without blocks: the catch-up queues them.
      const backlog = await db
        .insert(notes)
        .values(
          Array.from({ length: BACKLOG }, (_, i) => ({
            vaultId: vault!.id,
            type: 'note',
            name: `b${i}`,
            path: `backlog-${stamp}-${i}.md`,
            body: `backlog ${i}`,
            frontmatter: {},
          })),
        )
        .returning({ id: notes.id, path: notes.path })
      const ours = new Set(backlog.map((n) => n.path))

      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const order: string[] = []
      const embed = embedder.embed.bind(embedder)
      vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
        await gate
        const path = texts[0]!.slice(0, texts[0]!.indexOf('\n'))
        if (ours.has(path)) order.push(path)
        return embed(texts)
      })

      expect(await scheduleMissingEmbeddings()).toBeGreaterThanOrEqual(BACKLOG)
      const written = await createNote(vault!.id, { path: `written-${stamp}`, body: 'written after boot' })
      ours.add(written.path)
      release()
      await flushEmbeddings()

      expect(order).toHaveLength(BACKLOG + 1)
      expect(order.indexOf(written.path)).toBeLessThanOrEqual(1)
      // The backlog is still served after it.
      const embedded = await db
        .selectDistinct({ id: blocks.ownerId })
        .from(blocks)
        .where(and(eq(blocks.ownerType, 'note'), inArray(blocks.ownerId, backlog.map((n) => n.id)), isNotNull(blocks.embedding)))
      expect(embedded).toHaveLength(BACKLOG)
    } finally {
      await db.delete(vaults).where(eq(vaults.id, vault!.id))
    }
  })
})
