import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { findSymbols, searchNotes, type SymbolSearchResult } from '../src/search/search.js'
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

describe('symbol embeddings and precise retrieval (#262)', () => {
  it('indexes symbol embeddings and retrieves precise function with start/end lines and snippet', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(
      repo.id,
      [
        {
          path: 'src/auth/token.ts',
          content: [
            'export interface TokenPayload { id: string; role: string; }',
            'export function generateAuthToken(payload: TokenPayload): string {',
            '  return "signed." + payload.id;',
            '}',
            'export class TokenValidator {',
            '  validate(token: string) { return Boolean(token); }',
            '}',
          ].join('\n'),
        },
      ],
      ['src/auth/token.ts'],
    )
    await flushExtraction()

    // Test findSymbols directly
    const symbols = await findSymbols([repo.id], 'generateAuthToken')
    expect(symbols.length).toBeGreaterThan(0)
    const fn = symbols.find((s) => s.name === 'generateAuthToken')
    expect(fn).toBeDefined()
    expect(fn?.kind).toBe('function')
    expect(fn?.path).toBe('src/auth/token.ts')
    expect(fn?.startLine).toBe(2)
    expect(fn?.endLine).toBe(4)
    expect(fn?.snippet).toContain('return "signed."')

    // Test kind filter
    const interfaces = await findSymbols([repo.id], 'Token', { kind: 'interface' })
    expect(interfaces.every((s) => s.kind === 'interface')).toBe(true)
    expect(interfaces.some((s) => s.name === 'TokenPayload')).toBe(true)

    // Test searchNotes with includeSymbols
    const allResults = await searchNotes(
      { vaultIds: [], repositoryIds: [repo.id] },
      'TokenValidator',
      20,
      {},
      { includeSymbols: true },
    )
    const symbolResult = allResults.find((r) => r.resourceType === 'symbol' && r.symbolName === 'TokenValidator')
    expect(symbolResult).toBeDefined()
    expect(symbolResult?.symbolKind).toBe('class')
    expect(symbolResult?.startLine).toBe(5)
  })

  it('provides symbol search endpoints over API', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const [repo] = await db
      .insert(repositories)
      .values({ name: 'api-symbol-repo', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()

    await syncRepositoryFiles(
      repo!.id,
      [
        {
          path: 'math.py',
          content: 'def calculateHypotenuse(a, b):\n    return (a**2 + b**2)**0.5\n',
        },
      ],
      ['math.py'],
    )
    await flushExtraction()

    // Single repo symbol search
    const repoRes = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repo!.id}/symbols/search?q=calculateHypotenuse`,
      headers: { cookie },
    })
    expect(repoRes.statusCode).toBe(200)
    const repoSymbols = repoRes.json() as SymbolSearchResult[]
    expect(repoSymbols.some((s) => s.name === 'calculateHypotenuse')).toBe(true)

    // Everywhere symbol search
    const allRes = await app.inject({
      method: 'GET',
      url: `/api/symbols/search?q=calculateHypotenuse`,
      headers: { cookie },
    })
    expect(allRes.statusCode).toBe(200)
    const allSymbols = allRes.json() as SymbolSearchResult[]
    expect(allSymbols.some((s) => s.name === 'calculateHypotenuse')).toBe(true)
  })
})
