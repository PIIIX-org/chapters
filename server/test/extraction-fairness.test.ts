import { createHash } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/client.js'
import { repositories, repositoryFiles } from '../src/db/schema.js'
import { enqueueExtractions, extractionWork, flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser } from './helpers.js'

/** Inserts the files in one statement; returns their ids in the order of `paths`. */
async function addFiles(repositoryId: string, paths: string[]): Promise<string[]> {
  const rows = await db
    .insert(repositoryFiles)
    .values(
      paths.map((path) => ({
        repositoryId,
        path,
        content: path,
        contentHash: createHash('sha256').update(path).digest('hex'),
        size: path.length,
      })),
    )
    .returning({ id: repositoryFiles.id, path: repositoryFiles.path })
  const idByPath = new Map(rows.map((r) => [r.path, r.id]))
  return paths.map((p) => idByPath.get(p)!)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('extraction queue fairness across repositories (#497)', () => {
  it("one repository's large backlog delays another repository's file by at most one turn", async () => {
    const owner = await createActiveUser()
    const [big] = await db
      .insert(repositories)
      .values({ name: 'fairness-big', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()
    const [small] = await db
      .insert(repositories)
      .values({ name: 'fairness-small', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()
    // Two turns of 10 files: plain FIFO would serve the small file 21st.
    const BACKLOG = 20

    // Only the scheduler is under test: real `jobs` rows, claims and turns,
    // but the extraction of each file is replaced by recording its path, so
    // a file costs two statements (claim, complete), not a whole extraction
    // (#849: 101 real extractions ran past 5 s on a loaded machine). The first
    // file is held until both repositories are enqueued, so the order depends
    // only on the queue, not on timing.
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const pathById = new Map<string, string>()
    const order: string[] = []
    vi.spyOn(extractionWork, 'processFile').mockImplementation(async (fileId) => {
      await gate
      order.push(pathById.get(fileId)!)
    })

    const bigPaths = Array.from({ length: BACKLOG }, (_, i) => `big/f${i}.txt`)
    const bigIds = await addFiles(big!.id, bigPaths)
    bigIds.forEach((id, i) => pathById.set(id, bigPaths[i]!))
    await enqueueExtractions(bigIds)
    const [smallId] = await addFiles(small!.id, ['small/only.txt'])
    pathById.set(smallId!, 'small/only.txt')
    await enqueueExtractions([smallId!])
    release()
    await flushExtraction()

    expect(order).toHaveLength(BACKLOG + 1)
    // The big repository's first turn (at most 10 files, the in-flight one
    // included) runs before the small repository gets its turn.
    expect(order.indexOf('small/only.txt')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('small/only.txt')).toBeLessThanOrEqual(10)
    // Within one repository, files keep their enqueue order.
    expect(order.filter((p) => p.startsWith('big/'))).toEqual(bigPaths)

    await db.delete(repositories).where(inArray(repositories.id, [big!.id, small!.id]))
  })
})
