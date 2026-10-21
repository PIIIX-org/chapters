import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { createActiveUser } from './helpers.js'

async function makeRepo(name: string) {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning()
  return repo!
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('extraction queue fairness across repositories (#497)', () => {
  it("one repository's large backlog delays another repository's file by at most one turn", async () => {
    const big = await makeRepo('fairness-big')
    const small = await makeRepo('fairness-small')
    const BACKLOG = 100

    // Hold every extraction until both syncs have enqueued, so the order of
    // processing depends only on the queue, not on timing. The first text
    // given to the embedder is `${path}\n${content}` of the file being extracted.
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const order: string[] = []
    const embed = embedder.embed.bind(embedder)
    vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
      await gate
      order.push(texts[0]!.split('\n', 1)[0]!)
      return embed(texts)
    })

    const bigFiles = Array.from({ length: BACKLOG }, (_, i) => ({ path: `big/f${i}.txt`, content: `big file ${i}` }))
    await syncRepositoryFiles(
      big.id,
      bigFiles,
      bigFiles.map((f) => f.path),
    )
    await syncRepositoryFiles(small.id, [{ path: 'small/only.txt', content: 'small file' }], ['small/only.txt'])
    release()
    await flushExtraction()

    expect(order).toHaveLength(BACKLOG + 1)
    // The big repository's first turn (at most 10 files, the in-flight one
    // included) runs before the small repository gets its turn.
    expect(order.indexOf('small/only.txt')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('small/only.txt')).toBeLessThanOrEqual(10)
    // Within one repository, files keep their enqueue order.
    expect(order.filter((p) => p.startsWith('big/'))).toEqual(bigFiles.map((f) => f.path))
  })
})
