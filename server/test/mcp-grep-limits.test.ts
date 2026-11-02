// #468: what bounds a `grep` scan. A scan that reaches its cap on files ends the list with `{capped: {files, after}}`
// and a cursor, and the next page goes on from there; a statement past its time limit is BUSY (retryable). The
// tool's own cases: mcp-grep.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { repositoryFiles } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { scanLimits } from '../src/repositories/grep.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let app: FastifyInstance
let cookie: string
let bigRepoId: string
let agent: Client

async function grep(args: Record<string, unknown>) {
  resetRateLimits()
  const result = await agent.callTool({ name: 'grep', arguments: args })
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
  return { isError: result.isError === true, text, json: JSON.parse((result.content as Array<{ text?: string }>)[0]!.text!) as Json }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  const repo = async (name: string) => (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name, ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  bigRepoId = await repo('grep-big')
  // A repository of 1,100 files, `needle` in the last five: scanned in chunks.
  await db.insert(repositoryFiles).values(
    Array.from({ length: 1_100 }, (_, i) => ({
      repositoryId: bigRepoId,
      path: `d/${String(i).padStart(4, '0')}.txt`,
      content: i >= 1_095 ? 'needle\n' : 'hay\n',
      contentHash: `h${i}`,
      size: 7,
    })),
  )
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'grep-limits', scope: 'account' } })
  agent = new Client({ name: 'grep-limits', version: '0.0.0' })
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } } }))
}, 120_000)

afterAll(async () => {
  await agent.close().catch(() => {})
  await app.close()
})

describe('grep limits (#468)', () => {
  it('a statement past its time limit is BUSY, retryable, and says how to narrow', async () => {
    const saved = { ...scanLimits }
    scanLimits.statementMs = 20
    try {
      // 100,000 lines of 80 characters.
      const heavy = await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'grep-heavy', ingestionMethod: 'agent_push' } })
      await db.execute(sql`INSERT INTO repository_files (repository_id, path, content, content_hash, size)
        SELECT ${heavy.json<{ id: string }>().id}, 'heavy.txt', string_agg(repeat('a', 80), chr(10)), 'heavy', 8000000 FROM generate_series(1, 100000)`)
      const r = await grep({ repositoryId: heavy.json<{ id: string }>().id, pattern: '(a|b|[a-z])*(x|z)+needle$' })
      expect([r.isError, r.json.error?.code, r.json.error?.retryable, r.json.error?.message]).toEqual([true, 'BUSY', true, expect.stringContaining('narrow')])
    } finally {
      Object.assign(scanLimits, saved)
    }
  })

  it('a scan that reaches its cap ends the list with a marker and a cursor, and the next page goes on', async () => {
    const saved = { ...scanLimits }
    scanLimits.files = 500
    try {
      const found: string[] = []
      let cursor: string | undefined
      const markers: Json[] = []
      for (let page = 0; page < 6; page++) {
        const r = await grep({ repositoryId: bigRepoId, pattern: 'needle', ...(cursor ? { cursor } : {}) })
        expect(r.isError, r.text).toBe(false)
        for (const h of r.json.hits) (h.capped ? markers : found).push(h.capped ?? h.path)
        cursor = r.json.truncated === false ? undefined : (r.json.truncated.cursor ?? undefined)
        if (!cursor) break
      }
      expect(found).toEqual(['d/1095.txt', 'd/1096.txt', 'd/1097.txt', 'd/1098.txt', 'd/1099.txt'])
      expect(markers).toEqual([
        { files: 500, after: 'd/0499.txt' },
        { files: 500, after: 'd/0999.txt' },
      ])
    } finally {
      Object.assign(scanLimits, saved)
    }
  })

  it('answers `truncated` first with what a capped scan did not read', async () => {
    const saved = { ...scanLimits }
    scanLimits.files = 500
    try {
      const r = await grep({ repositoryId: bigRepoId, pattern: 'needle' })
      expect(r.json.truncated).toMatchObject({ cursor: expect.any(String) })
      expect(r.json.scanned).toBe(500)
    } finally {
      Object.assign(scanLimits, saved)
    }
  })
})
