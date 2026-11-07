// #468: the REST face of grep: GET /vaults/:id/grep, /repositories/:id/grep and /grep. Hits are those of the MCP tool, the
// next page is the `next` cursor, a refused pattern is 400, a vault or repository the caller cannot reach is 404.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { repositoryFiles } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let cookie: string
let otherCookie: string
let vaultId: string
let repoId: string

const get = async (url: string, as = cookie) => app.inject({ method: 'GET', url, headers: { cookie: as } })

beforeAll(async () => {
  app = await buildApp()
  cookie = await loginCookie(app, (await createActiveUser()).email)
  otherCookie = await loginCookie(app, (await createActiveUser()).email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'grep-rest-notes' } })).json().id
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'grep-rest-code', ingestionMethod: 'agent_push' } })).json().id
  await syncRepositoryFiles(repoId, [{ path: 'src/a.ts', content: 'export function alpha() {\n  return 1 // TODO: one\n}\n' }], ['src/a.ts'])
  await flushExtraction()
  await createNote(vaultId, { path: 'notes/todo', body: 'Nothing.\nTODO: note\n' })
  await db.insert(repositoryFiles).values({ repositoryId: repoId, path: 'many.txt', content: `${Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join('\n')}\n`, contentHash: 'many', size: 1 })
}, 60_000)

afterAll(async () => {
  await app.close()
})

describe('REST grep (#468)', () => {
  it('a repository: located hits with the indexed version, and context', async () => {
    const res = await get(`/api/repositories/${repoId}/grep?pattern=TODO&path=src/**&context=1`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.hits).toEqual([expect.objectContaining({ path: 'src/a.ts', line: 2, lines: [1, 3], block: expect.any(String), tokens: expect.any(Number), snippet: 'export function alpha() {\n  return 1 // TODO: one\n}' })])
    expect(body.tree ?? body.commit).toEqual(expect.any(String))
    expect(body).toMatchObject({ next: null, capped: null })
  })

  it('a vault: lines as read_note numbers them', async () => {
    const body = (await get(`/api/vaults/${vaultId}/grep?pattern=TODO`)).json()
    expect(body.hits.map((h: { path: string; line: number }) => [h.path, h.line])).toEqual([['notes/todo', 6]])
  })

  it('everywhere names each hit\'s source, vaults first', async () => {
    const body = (await get('/api/grep?pattern=TODO')).json()
    expect(body.hits.map((h: { vaultId?: string; repositoryId?: string; path: string }) => [h.vaultId ?? h.repositoryId, h.path])).toEqual([
      [vaultId, 'notes/todo'],
      [repoId, 'src/a.ts'],
    ])
  })

  it('pages by `next`: the pages are the whole answer', async () => {
    const seen: number[] = []
    let after = ''
    for (let page = 0; page < 4; page++) {
      const body = (await get(`/api/repositories/${repoId}/grep?pattern=%5Erow${after}`)).json()
      seen.push(...body.hits.map((h: { line: number }) => h.line))
      if (body.next === null) break
      after = `&after=${encodeURIComponent(body.next)}`
    }
    expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => i + 1))
  })

  it('refuses a back reference, a bad cursor and a missing pattern with 400; another account gets 404', async () => {
    expect((await get(`/api/repositories/${repoId}/grep?pattern=(a)%5C1`)).statusCode).toBe(400)
    expect((await get(`/api/repositories/${repoId}/grep?pattern=a&after=nope`)).statusCode).toBe(400)
    expect((await get(`/api/repositories/${repoId}/grep`)).statusCode).toBe(400)
    expect((await get(`/api/repositories/${repoId}/grep?pattern=TODO`, otherCookie)).statusCode).toBe(404)
    expect((await get(`/api/vaults/${vaultId}/grep?pattern=TODO`, otherCookie)).statusCode).toBe(404)
    expect((await get('/api/grep?pattern=TODO', otherCookie)).json().hits).toEqual([])
  })
})
