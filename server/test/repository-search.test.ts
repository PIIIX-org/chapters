import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { searchNotes } from '../src/search/search.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

async function makeRepo() {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'search-test', ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning()
  return repo!
}

describe('searchNotes over vaults and repositories', () => {
  it('finds code by keyword with resourceType and a highlighted snippet', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(
      repo.id,
      [{ path: 'src/quantum.ts', content: 'export function quantumFluxCapacitor() {}' }],
      ['src/quantum.ts'],
    )
    await flushExtraction()

    const results = await searchNotes({ vaultIds: [], repositoryIds: [repo.id] }, 'quantumFluxCapacitor')
    expect(results[0]?.resourceType).toBe('code')
    expect(results[0]?.path).toBe('src/quantum.ts')
    expect(results[0]?.snippet).toContain('<b>')
  })

  it('still returns note results unchanged in shape when only vaults are queried', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const vault = (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie },
        body: { name: 'search-notes-vault' },
      })
    ).json() as { id: string }
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vault.id}/notes`,
      headers: { cookie },
      body: { type: 'docs', name: 'note', body: 'unmistakable keyword zephyrtoken here' },
    })

    const results = await searchNotes({ vaultIds: [vault.id], repositoryIds: [] }, 'zephyrtoken')
    expect(results[0]?.resourceType).toBe('note')
    expect(results[0]?.frontmatter).toBeTruthy()
  })

  it('merges note and code results in one ranked list for a single query', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const vault = (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie },
        body: { name: 'merged-search-vault' },
      })
    ).json() as { id: string }
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vault.id}/notes`,
      headers: { cookie },
      body: { type: 'docs', name: 'plan', body: 'orbitalthruster design plan' },
    })
    const repo = await makeRepo()
    await syncRepositoryFiles(repo.id, [{ path: 'thruster.py', content: '# orbitalthruster control loop' }], ['thruster.py'])
    await flushExtraction()

    const results = await searchNotes({ vaultIds: [vault.id], repositoryIds: [repo.id] }, 'orbitalthruster')
    const types = new Set(results.map((r) => r.resourceType))
    expect(types.has('note')).toBe(true)
    expect(types.has('code')).toBe(true)
  })

  it('never returns results from a repository outside the resource set', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(repo.id, [{ path: 'secret.ts', content: 'export const zzyxxsecretmarker = 1' }], ['secret.ts'])
    await flushExtraction()

    const results = await searchNotes({ vaultIds: [], repositoryIds: [] }, 'zzyxxsecretmarker')
    expect(results).toEqual([])
  })
})
