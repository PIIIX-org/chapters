// #534: `orient` goes on past its ten entries with `cursor` (the next ten of the first list that has more), and a definition
// the repository calls only by guessed name (Python's cross-file calls are never resolved) ranks by those calls, below resolved ones.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let agent: Client
let pagedRepo: string
let pythonRepo: string

type Answer = { symbols?: Array<{ at: string; symbol: string; refs: number; guessed?: number }>; folders?: Array<{ path: string }>; truncated: false | { cursor: string | null; total: Record<string, number | string> } }

async function orient(args: Record<string, unknown>): Promise<Answer> {
  resetRateLimits()
  const result = await agent.callTool({ name: 'orient', arguments: { budget_tokens: 4_000, ...args } })
  expect(result.isError).not.toBe(true)
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Answer
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const cookie = await loginCookie(app, (await createActiveUser()).email)
  const repo = async (name: string) => (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name, ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  pagedRepo = await repo('orient-paged')
  pythonRepo = await repo('orient-python')
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`src/m${String(i).padStart(2, '0')}.ts`, `export function m${String(i).padStart(2, '0')}(): number {\n  return ${i}\n}\n`]))
  await syncRepositoryFiles(pagedRepo, Object.entries(many).map(([path, content]) => ({ path, content })), Object.keys(many))
  const python: Record<string, string> = {
    'lib/other.py': 'def rare():\n    return 0\n',
    'lib/util.py': 'def helper():\n    return 1\n',
    'app/a.py': 'from lib.util import helper\n\ndef a():\n    return helper()\n',
    'app/b.py': 'from lib.util import helper\n\ndef b():\n    return helper()\n',
    'app/c.py': 'from lib.util import helper\n\ndef c():\n    return helper()\n',
  }
  await syncRepositoryFiles(pythonRepo, Object.entries(python).map(([path, content]) => ({ path, content })), Object.keys(python))
  await flushExtraction()
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'orient-paging', scope: 'account' } })
  agent = new Client({ name: 'orient-paging', version: '0.0.0' })
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } } }))
}, 120_000)

afterAll(async () => {
  await agent.close().catch(() => {})
  await app.close()
})

describe('orient pages past ten entries (#534)', () => {
  it('the cursor continues the definitions ten at a time: the pages are the whole ranking, once each', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const answer = await orient({ repositoryId: pagedRepo, ...(cursor ? { cursor } : {}) })
      expect(answer.symbols!.length).toBeLessThanOrEqual(10)
      seen.push(...answer.symbols!.map((s) => s.symbol))
      cursor = answer.truncated === false ? undefined : (answer.truncated.cursor ?? undefined)
      if (!cursor) break
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `m${String(i).padStart(2, '0')}`))
  })

  it('the first page says that more exist', async () => {
    const answer = await orient({ repositoryId: pagedRepo })
    expect(answer.truncated).toMatchObject({ total: { symbols: '>10' }, cursor: expect.any(String) })
  })
})

describe('orient ranks guessed uses (#534)', () => {
  it('a definition only called by name from other files outranks an unused one, and shows how many (an import and a call per file)', async () => {
    const answer = await orient({ repositoryId: pythonRepo })
    const helper = answer.symbols!.find((s) => s.symbol === 'helper')!
    expect(helper.refs).toBe(0)
    expect(helper.guessed).toBeGreaterThanOrEqual(3)
    expect(answer.symbols!.findIndex((s) => s.symbol === 'helper')).toBeLessThan(answer.symbols!.findIndex((s) => s.symbol === 'rare'))
  })
})
