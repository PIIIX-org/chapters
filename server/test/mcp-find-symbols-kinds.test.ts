// #450: find_symbols filters by the new kinds (method, enum, variable,
// namespace), and a method comes with its class in `parent` while `name`
// stays the bare method name, so an exact-name query still finds it first.
// read_file's outline carries `parent` the same way.
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
let repoId: string
let agent: Client

const source = [
  'export enum Mode { Fast, Safe }',
  'export const RETRY_LIMIT = 3',
  'export class Uploader {',
  '  resumeUpload(id: string) { return id }',
  '}',
  'export const resumeUploadLater = (id: string) => id',
].join('\n')

async function call(tool: string, args: Record<string, unknown>) {
  resetRateLimits()
  const result = await agent.callTool({ name: tool, arguments: args })
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
  return { isError: result.isError === true, text }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  repoId = (
    await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'symbol-kinds', ingestionMethod: 'agent_push' } })
  ).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'symbol-kinds-agent', scope: 'account' } })
  agent = new Client({ name: 'symbol-kinds-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  await syncRepositoryFiles(repoId, [{ path: 'src/upload.ts', content: source }], ['src/upload.ts'])
  await flushExtraction()
}, 120_000)

afterAll(async () => {
  await agent.close().catch(() => {})
  await app.close()
})

describe('find_symbols kinds and parents (#450)', () => {
  it('filters by method and names the class in `parent`; the bare name matches exactly', async () => {
    const r = await call('find_symbols', { repositoryId: repoId, query: 'resumeUpload', kind: 'method' })
    expect(r.isError, r.text).toBe(false)
    const { results } = JSON.parse(r.text) as { results: Array<Record<string, unknown>> }
    expect(results.map((s) => [s.kind, s.parent, s.name, s.startLine])).toEqual([['method', 'Uploader', 'resumeUpload', 4]])
  })

  it('finds a method by `Class.method`', async () => {
    const r = await call('find_symbols', { repositoryId: repoId, query: 'Uploader.resumeUpload' })
    expect(r.isError, r.text).toBe(false)
    const { results } = JSON.parse(r.text) as { results: Array<Record<string, unknown>> }
    // The keyword match adds to its semantic rank: first of every symbol.
    expect([results[0]?.parent, results[0]?.name]).toEqual(['Uploader', 'resumeUpload'])
  })

  it('filters by enum and variable', async () => {
    for (const [kind, query, name] of [
      ['enum', 'Mode', 'Mode'],
      ['variable', 'RETRY_LIMIT', 'RETRY_LIMIT'],
    ] as const) {
      const r = await call('find_symbols', { repositoryId: repoId, query, kind })
      expect(r.isError, r.text).toBe(false)
      const { results } = JSON.parse(r.text) as { results: Array<Record<string, unknown>> }
      expect(results.map((s) => [s.kind, s.name])).toEqual([[kind, name]])
      expect(results[0]).not.toHaveProperty('parent')
    }
  })

  it("read_file's outline lists methods with their parent", async () => {
    const r = await call('read_file', { repositoryId: repoId, path: 'src/upload.ts' })
    expect(r.isError, r.text).toBe(false)
    const { symbols } = JSON.parse(r.text) as { symbols: Array<Record<string, unknown>> }
    expect(symbols).toEqual([
      { name: 'Mode', kind: 'enum', startLine: 1, endLine: 1 },
      { name: 'RETRY_LIMIT', kind: 'variable', startLine: 2, endLine: 2 },
      { name: 'Uploader', kind: 'class', startLine: 3, endLine: 5 },
      { name: 'resumeUpload', kind: 'method', parent: 'Uploader', startLine: 4, endLine: 4 },
      { name: 'resumeUploadLater', kind: 'function', startLine: 6, endLine: 6 },
    ])
  })
})
