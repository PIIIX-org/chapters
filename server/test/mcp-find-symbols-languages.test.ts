// #464: find_symbols and read_file's outline cover the new languages (a Rust
// struct and its impl methods here); a Markdown file's heading sections are
// search blocks, not symbols, so find_symbols never lists them.
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

const rust = ['pub struct Uploader;', '', 'impl Uploader {', '    pub fn resume_upload(&self) {}', '}', ''].join('\n')
const guide = ['# Uploader guide', '', '## Resume upload', '', 'Call it again.', ''].join('\n')

async function call(tool: string, args: Record<string, unknown>) {
  resetRateLimits()
  const result = await agent.callTool({ name: tool, arguments: args })
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
  expect(result.isError === true, text).toBe(false)
  return JSON.parse(text) as Record<string, unknown>
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  repoId = (
    await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'symbol-languages', ingestionMethod: 'agent_push' } })
  ).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'symbol-languages-agent', scope: 'account' } })
  agent = new Client({ name: 'symbol-languages-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  const files = [
    { path: 'src/upload.rs', content: rust },
    { path: 'docs/guide.md', content: guide },
  ]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await flushExtraction()
}, 120_000)

afterAll(async () => {
  await agent.close().catch(() => {})
  await app.close()
})

describe('find_symbols and read_file for the new languages (#464)', () => {
  it('finds a Rust impl method with its struct in `parent`, and the struct as a class', async () => {
    const methods = (await call('find_symbols', { repositoryId: repoId, query: 'resume_upload', kind: 'method' })).results as Array<Record<string, unknown>>
    expect(methods.map((s) => [s.path, s.kind, s.parent, s.name, s.startLine])).toEqual([['src/upload.rs', 'method', 'Uploader', 'resume_upload', 4]])
    const classes = (await call('find_symbols', { repositoryId: repoId, query: 'Uploader', kind: 'class' })).results as Array<Record<string, unknown>>
    expect(classes.map((s) => [s.path, s.name])).toEqual([['src/upload.rs', 'Uploader']])
  })

  it('never lists a Markdown heading section', async () => {
    const results = (await call('find_symbols', { repositoryId: repoId, query: 'Resume upload' })).results as Array<Record<string, unknown>>
    expect(results.filter((s) => s.path === 'docs/guide.md')).toEqual([])
  })

  it("read_file labels the files and outlines the Rust one; the Markdown file's outline has no symbols", async () => {
    const rs = await call('read_file', { repositoryId: repoId, path: 'src/upload.rs' })
    expect(rs.language).toBe('rust')
    expect(rs.symbols).toEqual([
      { name: 'Uploader', kind: 'class', startLine: 1, endLine: 1 },
      { name: 'resume_upload', kind: 'method', parent: 'Uploader', startLine: 4, endLine: 4 },
    ])
    const md = await call('read_file', { repositoryId: repoId, path: 'docs/guide.md' })
    expect(md.language).toBe('markdown')
    expect(md.symbols ?? []).toEqual([])
  })
})
