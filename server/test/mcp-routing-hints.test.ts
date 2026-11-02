// #674: tools that have a cheaper route for the request say so in the head of the answer, as `hint`: literal text
// searched in one repository (rg), a long text read from the top (outline, then targets). Never when the request is
// Elara's own business (a vault, several repositories, meaning, a name), and never in place of the answer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let app: FastifyInstance
let vaultId: string
let repoId: string
let agent: Client

const LONG = `${Array.from({ length: 450 }, (_, i) => `// line ${i + 1}`).join('\n')}\nexport function longOne() {}\n`

async function call(tool: string, args: Record<string, unknown>) {
  resetRateLimits()
  const result = await agent.callTool({ name: tool, arguments: args })
  const text = (result.content as Array<{ text?: string }>)[0]!.text!
  return { json: JSON.parse(text) as Json, structured: result.structuredContent as Json | undefined }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'hints-notes' } })).json<{ id: string }>().id
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'hints-code', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  await syncRepositoryFiles(
    repoId,
    [
      { path: 'src/long.ts', content: LONG },
      { path: 'src/short.ts', content: 'export function shortOne() {\n  return "connection reset by peer"\n}\n' },
    ],
    ['src/long.ts', 'src/short.ts'],
  )
  await flushExtraction()
  const lines = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`)
  await createNote(vaultId, { path: 'notes/long', body: `# Long\n\n## Part\n\n${lines.join('\n')}\n` })
  await createNote(vaultId, { path: 'notes/log', body: `${lines.join('\n')}\n` })
  await createNote(vaultId, { path: 'notes/short', body: 'connection reset by peer\n' })
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'hints', scope: 'account' } })
  agent = new Client({ name: 'hints', version: '0.0.0' })
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } } }))
}, 120_000)

afterAll(async () => {
  await agent.close().catch(() => {})
  await app.close()
})

describe('routing hints (#674)', () => {
  it('search for literal text in one repository still answers, with the rg hint in the head and in structuredContent', async () => {
    const r = await call('search', { repositoryId: repoId, query: '"connection reset by peer"' })
    expect(r.json.hint).toBe("exact text, not meaning: in a checked-out repo `rg -n -F -- 'connection reset by peer'` lists every occurrence for less than a ranked search")
    expect(r.json.results.map((h: Json) => h.path)).toContain('src/short.ts')
    expect(r.structured?.hint).toBe(r.json.hint)
  })

  it("search that is Elara's business has no hint: a vault, everywhere, meaning, a name", async () => {
    for (const args of [
      { vaultId, query: '"connection reset by peer"' },
      { everywhere: true, query: '"connection reset by peer"' },
      { repositoryId: repoId, query: 'what happens when the connection resets?' },
      { repositoryId: repoId, query: 'shortOne' },
    ]) {
      const r = await call('search', args)
      expect(r.json.hint, JSON.stringify(args)).toBeUndefined()
    }
  })

  it('a long file or note read from the top says to take the outline first; targets, outline, later pages and short texts do not', async () => {
    for (const [tool, args] of [
      ['read_file', { repositoryId: repoId, path: 'src/long.ts' }],
      ['read_note', { vaultId, path: 'notes/long' }],
    ] as const) {
      const whole = await call(tool, { ...args, budget_tokens: 256 })
      expect(whole.json.hint, tool).toMatch(/^4\d\d lines: `outline: true`, then `targets`/)
      expect(whole.json.truncated.cursor, tool).toEqual(expect.any(String))
      const next = await call(tool, { ...args, budget_tokens: 256, cursor: whole.json.truncated.cursor })
      expect(next.json.hint, `${tool} later page`).toBeUndefined()
      expect((await call(tool, { ...args, outline: true })).json.hint, `${tool} outline`).toBeUndefined()
      expect((await call(tool, { ...args, targets: [{ lines: '1-3' }] })).json.hint, `${tool} targets`).toBeUndefined()
    }
    // No outline to take (a log): line targets.
    expect((await call('read_note', { vaultId, path: 'notes/log', budget_tokens: 256 })).json.hint).toMatch(/^45\d lines: `targets: \[\{lines: "a-b"\}\]` costs less/)
    // A session re-read answers `same_as`, short already: no hint.
    const session = { session_id: 'hints-session-1' }
    const first = await call('read_file', { repositoryId: repoId, path: 'src/long.ts', ...session, budget_tokens: 25_000 })
    expect(first.json.hint).toMatch(/lines/)
    const again = await call('read_file', { repositoryId: repoId, path: 'src/long.ts', ...session, budget_tokens: 25_000 })
    expect(JSON.stringify(again.json)).toContain('same_as')
    expect(again.json.hint).toBeUndefined()
    expect((await call('read_file', { repositoryId: repoId, path: 'src/short.ts' })).json.hint).toBeUndefined()
    expect((await call('read_note', { vaultId, path: 'notes/short' })).json.hint).toBeUndefined()
  })
})
