// #470: GET /api/repositories/:id/code-refs answers the same questions as `find_symbols` with `refs`
// (mcp-code-queries.test.ts) over REST: plain JSON, `next` for the next offset, 404 for a repository
// the account cannot read (the answer of a missing one), 400 for arguments that contradict.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'
import { FIXTURE } from './code-queries-fixture.js'

let app: FastifyInstance
let cookie: string
let strangerCookie: string
let repoId: string

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const get = async (who: string, id: string, query: Record<string, string | number>) => {
  const res = await app.inject({ method: 'GET', url: `/api/repositories/${id}/code-refs`, headers: { cookie: who }, query: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) })
  return { status: res.statusCode, body: res.json<Json>() }
}

beforeAll(async () => {
  app = await buildApp()
  cookie = await loginCookie(app, (await createActiveUser()).email)
  strangerCookie = await loginCookie(app, (await createActiveUser()).email)
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'code-refs-routes', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  await syncRepositoryFiles(
    repoId,
    Object.entries(FIXTURE).map(([path, content]) => ({ path, content })),
    Object.keys(FIXTURE),
  )
  await flushExtraction()
}, 120_000)

afterAll(async () => {
  await app.close()
})

describe('GET /repositories/:id/code-refs (#470)', () => {
  it('callers, with the symbol and the rows', async () => {
    const { status, body } = await get(cookie, repoId, { query: 'normalize', refs: 'callers' })
    expect(status).toBe(200)
    expect(body.symbol).toMatchObject({ path: 'src/store.ts', name: 'normalize', line: 10 })
    expect(body.results.map((r: Json) => `${r.at} ${r.in ?? '-'} ${r.confidence}`)).toEqual([
      'src/handler.ts:6 handle resolved',
      'src/store.test.ts:4 - resolved',
      'src/store.ts:3 Store.save resolved',
    ])
    expect(body).not.toHaveProperty('next')
  })

  it('pages by offset: next is where the following page starts', async () => {
    const first = await get(cookie, repoId, { query: 'normalize', refs: 'references', limit: 2 })
    expect([first.body.results.length, first.body.next]).toEqual([2, 2])
    const second = await get(cookie, repoId, { query: 'normalize', refs: 'references', limit: 2, offset: first.body.next })
    const last = await get(cookie, repoId, { query: 'normalize', refs: 'references', limit: 2, offset: second.body.next })
    expect(last.body).not.toHaveProperty('next')
    const whole = await get(cookie, repoId, { query: 'normalize', refs: 'references' })
    expect([...first.body.results, ...second.body.results, ...last.body.results]).toEqual(whole.body.results)
  })

  it('at, impact and an ambiguous name', async () => {
    expect((await get(cookie, repoId, { query: 'src/store.ts:3', refs: 'at' })).body.symbol).toMatchObject({ name: 'save', parent: 'Store' })
    const impact = (await get(cookie, repoId, { query: 'normalize', refs: 'impact', depth: 3 })).body
    expect([impact.depth1.length, impact.depth2.length, impact.depth3.length, impact.total]).toEqual([3, 2, 1, { 1: 3, 2: 2, 3: 1 }])
    const ambiguous = (await get(cookie, repoId, { query: 'parse', refs: 'tests' })).body
    expect(ambiguous.candidates.map((c: Json) => c.path)).toEqual(['src/other.ts', 'src/store.ts'])
  })

  it('refuses contradicting arguments (400) and a symbol that is not there (404)', async () => {
    expect((await get(cookie, repoId, { query: 'normalize', refs: 'callers', depth: 2 })).status).toBe(400)
    expect((await get(cookie, repoId, { query: 'normalize', refs: 'impact', depth: 4 })).status).toBe(400)
    expect((await get(cookie, repoId, { query: 'src/store.ts', refs: 'at' })).status).toBe(400)
    expect((await get(cookie, repoId, { query: 'doesNotExist', refs: 'callers' })).status).toBe(404)
  })

  it('a repository of another account answers what a missing one does', async () => {
    const missing = await get(strangerCookie, '00000000-0000-4000-8000-000000000000', { query: 'normalize', refs: 'callers' })
    const foreign = await get(strangerCookie, repoId, { query: 'normalize', refs: 'callers' })
    expect(foreign).toEqual(missing)
    expect(foreign.status).toBe(404)
  })
})
