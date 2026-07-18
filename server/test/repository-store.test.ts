import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { getRepositoryFile, listRepositoryFiles, syncRepositoryFiles } from '../src/repositories/store.js'
import { createActiveUser } from './helpers.js'

async function makeRepo() {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'store-test', ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning()
  return repo!
}

describe('syncRepositoryFiles', () => {
  it('creates rows for a first sync', async () => {
    const repo = await makeRepo()
    const result = await syncRepositoryFiles(
      repo.id,
      [
        { path: 'src/index.ts', content: 'export const x = 1' },
        { path: 'README.md', content: '# hi' },
      ],
      ['src/index.ts', 'README.md'],
    )
    expect(result).toEqual({ created: 2, updated: 0, deleted: 0, unchanged: 0 })
    const files = await listRepositoryFiles(repo.id)
    expect(files.map((f) => f.path).sort()).toEqual(['README.md', 'src/index.ts'])
    expect(files.find((f) => f.path === 'src/index.ts')?.language).toBe('typescript')
  })

  it('updates only changed files, deletes missing ones, leaves unchanged alone', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(
      repo.id,
      [
        { path: 'a.ts', content: 'aaa' },
        { path: 'b.ts', content: 'bbb' },
        { path: 'c.ts', content: 'ccc' },
      ],
      ['a.ts', 'b.ts', 'c.ts'],
    )

    // Second sync: a.ts changed, b.ts unchanged, c.ts removed from manifest.
    const result = await syncRepositoryFiles(
      repo.id,
      [{ path: 'a.ts', content: 'aaa-changed' }],
      ['a.ts', 'b.ts'],
    )
    expect(result).toEqual({ created: 0, updated: 1, deleted: 1, unchanged: 0 })

    const a = await getRepositoryFile(repo.id, 'a.ts')
    expect(a?.content).toBe('aaa-changed')
    const b = await getRepositoryFile(repo.id, 'b.ts')
    expect(b?.content).toBe('bbb')
    const c = await getRepositoryFile(repo.id, 'c.ts')
    expect(c).toBeNull()
  })

  it('re-syncing identical content is a no-op', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(repo.id, [{ path: 'x.ts', content: 'same' }], ['x.ts'])
    const before = await getRepositoryFile(repo.id, 'x.ts')

    const result = await syncRepositoryFiles(repo.id, [{ path: 'x.ts', content: 'same' }], ['x.ts'])
    expect(result).toEqual({ created: 0, updated: 0, deleted: 0, unchanged: 1 })
    const after = await getRepositoryFile(repo.id, 'x.ts')
    expect(after?.updatedAt).toEqual(before?.updatedAt)
  })
})
