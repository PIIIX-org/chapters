// #414: the budget's ladder on a located search answer: without heading and tokens first, then `path#La-Lb` for a
// hit that points at a passage.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { LOCATE_HITS } from '../src/search/locate.js'
import { createNote } from '../src/notes/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'
import * as search from '../src/search/search.js'

let app: FastifyInstance
let vaultId: string
let agent: Client

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'ladder vault' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'ladder-agent', scope: 'account' } })
  agent = new Client({ name: 'ladder-test', version: '0.0.0' })
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } } }))
  for (let i = 0; i < 40; i++) {
    await createNote(vaultId, { path: `docs/ladder-${String(i).padStart(2, '0')}`, body: `# Ladder ${i}\n\nThe pomelo harvest notes number ${i}: ${'a long sentence about pomelo trees and their harvest. '.repeat(6)}\n` })
  }
  await flushExtraction()
  await flushEmbeddings()
}, 180_000)

afterAll(async () => {
  await agent.close().catch(() => {})
  await app.close()
})

const ask = async (budget: number) => {
  resetRateLimits()
  const res = await agent.callTool({ name: 'search', arguments: { vaultId, query: 'pomelo harvest', limit: 40, budget_tokens: budget } })
  return JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { results: unknown; truncated: { level: string } | false }
}

describe('search answers down the budget ladder (#414)', () => {
  it('whole hits carry their passage, the first rung drops the description, the locations rung is path#La-Lb', async () => {
    const whole = await ask(25_000)
    const first = (whole.results as Array<Record<string, unknown>>)[0]!
    expect(whole.truncated).toBe(false)
    expect(first).toMatchObject({ resourceType: 'note' })
    expect([first.block, first.channel]).toEqual([undefined, undefined])
    expect(first.heading).toBeDefined()
    expect(first.tokens).toBeGreaterThan(0)

    const trimmed = await ask(600)
    expect(trimmed.truncated).toMatchObject({ level: 'no_context' })
    const hit = (trimmed.results as Array<Record<string, unknown>>)[0]!
    expect(hit.snippet).toBeUndefined()
    expect(hit.heading).toBeUndefined()
    expect(hit.tokens).toBeUndefined()
    expect(hit.startLine).toBeDefined()

    const located = await ask(256)
    expect(located.truncated).toMatchObject({ level: 'locations' })
    const rows = located.results as unknown[]
    expect(rows.length).toBeGreaterThan(0)
    // The first LOCATE_HITS hits are located; a hit past them is its path.
    for (const row of rows.slice(0, LOCATE_HITS)) expect(row).toMatch(/^docs\/ladder-\d\d#L\d+-L\d+$/)
    for (const row of rows.slice(LOCATE_HITS)) expect(row).toMatch(/^docs\/ladder-\d\d$/)
  })

  it('a call that names its container leaves the container id out of the hits; `everywhere` keeps it even when only one container is reachable (the shape must not change when another is shared)', async () => {
    resetRateLimits()
    const named = await agent.callTool({ name: 'search', arguments: { vaultId, query: 'pomelo harvest', limit: 3 } })
    const namedHit = (JSON.parse((named.content as Array<{ text: string }>)[0]!.text).results as Array<Record<string, unknown>>)[0]!
    expect(namedHit).not.toHaveProperty('containerId')
    expect(namedHit.id).toEqual(expect.any(String))
    expect(namedHit.path).toMatch(/^docs\/ladder-/)
    resetRateLimits()
    const everywhere = await agent.callTool({ name: 'search', arguments: { everywhere: true, query: 'pomelo harvest', limit: 3 } })
    const anyHit = (JSON.parse((everywhere.content as Array<{ text: string }>)[0]!.text).results as Array<Record<string, unknown>>)[0]!
    expect(anyHit.containerId).toBe(vaultId)
  })
  it('rejects a continuation when passages of the same note reorder, even without located lines', async () => {
    const answer = await search.searchNotes({ vaultIds: [vaultId], repositoryIds: [] }, 'pomelo harvest', 1)
    const results = Array.from({ length: 12 }, (_, i) => ({
      ...answer.results[0]!,
      block: `b_passage_${i}`,
      startLine: undefined,
      endLine: undefined,
      snippet: `Passage ${i}: ${'pomelo harvest '.repeat(70)}`,
    }))
    const ranking = vi.spyOn(search, 'searchNotes').mockResolvedValue({ ...answer, results })
    const call = async (cursor?: string) => {
      resetRateLimits()
      const response = await agent.callTool({ name: 'search', arguments: { vaultId, query: 'pomelo harvest', limit: 12, budget_tokens: 2500, ...(cursor ? { cursor } : {}) } })
      return {
        isError: response.isError,
        json: JSON.parse((response.content as Array<{ text: string }>)[0]!.text),
      }
    }
    try {
      const first = await call()
      expect(first.isError).not.toBe(true)
      const cursor = first.json.truncated.cursor
      expect(cursor).toEqual(expect.any(String))
      expect(first.json.results.length).toBeGreaterThanOrEqual(5)
      expect(first.json.results[0]).not.toHaveProperty('block')
      expect((await call(cursor)).isError).not.toBe(true)

      ranking.mockResolvedValue({ ...answer, results: [results[1]!, results[0]!, ...results.slice(2)] })
      const stale = await call(cursor)
      expect(stale.isError).toBe(true)
      expect(stale.json).toMatchObject({ error: { code: 'CURSOR_STALE' } })
    } finally {
      ranking.mockRestore()
    }
  })
})
