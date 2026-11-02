// #419: an MCP `search` hit carries no frontmatter (42 % of a typical note hit's characters, measured below); REST keeps it for the UI's tags.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let vaultId: string
let cookie: string
let agent: Client

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'hits vault' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'hits-agent', scope: 'account' } })
  agent = new Client({ name: 'hits-test', version: '0.0.0' })
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } } }))
  await createNote(vaultId, { path: 'docs/kiwi', frontmatter: { title: 'Kiwi notes', tags: ['fruit', 'green', 'orchard'], owner: 'quokka-team', status: 'active', aliases: ['kiwifruit', 'Chinese gooseberry'], source: 'https://example.com/orchard/kiwi', reviewed: '2026-10-01' }, body: '# Kiwi\n\nThe kiwifruit harvest happens in autumn.\n' })
}, 120_000)

afterAll(async () => {
  await agent.close().catch(() => {})
  await app.close()
})

describe('search hits without frontmatter (#419)', () => {
  it('the MCP answer has no frontmatter, the REST answer keeps it', async () => {
    resetRateLimits()
    const mcp = await agent.callTool({ name: 'search', arguments: { vaultId, query: 'kiwifruit harvest autumn' } })
    const text = (mcp.content as Array<{ text?: string }>)[0]!.text!
    const hit = (JSON.parse(text) as { results: Array<Record<string, unknown>> }).results.find((r) => r.path === 'docs/kiwi')!
    expect(hit).toBeDefined()
    expect(hit.snippet).toBeDefined()
    expect('frontmatter' in hit).toBe(false)
    expect(text).not.toContain('quokka-team')

    const rest = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/search?q=kiwifruit harvest autumn`, headers: { cookie } })
    const restHit = rest.json<{ results: Array<{ path: string; frontmatter?: { tags?: string[] } }> }>().results.find((r) => r.path === 'docs/kiwi')!
    expect(restHit.frontmatter?.tags).toEqual(['fruit', 'green', 'orchard'])
  })

  it('saves what the frontmatter weighs: the measured size of one note hit, with and without it', async () => {
    resetRateLimits()
    const mcp = await agent.callTool({ name: 'search', arguments: { vaultId, query: 'kiwifruit harvest autumn' } })
    const hit = (JSON.parse((mcp.content as Array<{ text: string }>)[0]!.text) as { results: Array<Record<string, unknown>> }).results.find((r) => r.path === 'docs/kiwi')!
    const rest = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/search?q=kiwifruit harvest autumn`, headers: { cookie } })
    const withFrontmatter = rest.json<{ results: Array<{ path: string; frontmatter: unknown }> }>().results.find((r) => r.path === 'docs/kiwi')!.frontmatter
    const before = JSON.stringify({ ...hit, frontmatter: withFrontmatter }).length
    const after = JSON.stringify(hit).length
    // A typical note's metadata (title, three tags, owner, status, two aliases, a source, a review date) is a third of its hit.
    expect(after / before).toBeLessThan(0.7)
    expect((before - after) / 4).toBeGreaterThan(40)
    console.info(`#419 note hit: ${before} -> ${after} characters (${Math.round((1 - after / before) * 100)} % smaller, ~${Math.round((before - after) / 4)} tokens)`)
  })
})
