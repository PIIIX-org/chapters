// #425's measured token figure: `browse_vault {vaultId}`, the call an agent
// makes first, on a seeded 500-note vault shaped like a working vault (8
// type folders, 2-3 subfolders in some, frontmatter with type, status,
// title, created, tags and an issue link). Tokens are characters / 4, the
// premise benchmark's estimate. The call takes only `vaultId`, so this file
// runs unchanged on code from before #425 to give the "before" figure: it
// prints the figure there and fails its bound.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { notes } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let agent: Client
let vaultId: string

const FOLDERS: Array<[string, number, string[]]> = [
  ['fixes', 120, ['phase-1', 'phase-2', 'phase-3']],
  ['decision', 60, []],
  ['audit', 70, ['security', 'performance']],
  ['research', 80, ['landscape', 'benchmarks']],
  ['meeting', 50, []],
  ['project', 40, ['roadmap']],
  ['person', 30, []],
  ['howto', 50, ['self-hosting', 'agents']],
]
const WORDS = ['budget', 'cursor', 'graph', 'search', 'vault', 'index', 'token', 'paging', 'review', 'schema', 'backup', 'restore']

/** 500 notes, the same on every run. */
function seed(): Array<{ path: string; frontmatter: Record<string, unknown> }> {
  const out: Array<{ path: string; frontmatter: Record<string, unknown> }> = []
  for (const [type, count, subs] of FOLDERS) {
    for (let i = 0; i < count; i++) {
      const sub = subs.length > 0 && i % 2 === 1 ? `${subs[i % subs.length]}/` : ''
      const words = [0, 1, 2, 3, 4].map((k) => WORDS[(i * 7 + k * 5) % WORDS.length]!)
      out.push({
        path: `${type}/${sub}${words.slice(0, 3).join('-')}-${String(i).padStart(3, '0')}`,
        frontmatter: {
          type,
          status: i % 3 === 0 ? 'stable' : 'active',
          title: `${type} ${i}: ${words.join(' ')}`,
          created: new Date(Date.UTC(2026, 9, 1 + (i % 28), i % 24)).toISOString(),
          tags: words.slice(0, 2 + (i % 2)),
          ...(type === 'fixes' ? { issue: `https://github.com/PIIIX-org/chapters/issues/${400 + i}` } : {}),
        },
      })
    }
  }
  return out
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'browse tokens' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'browse-tokens-agent', scope: 'account' } })
  agent = new Client({ name: 'browse-vault-tokens-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  // The rows only: browse_vault reads nothing else (no file, projection or embedding needed).
  await db.insert(notes).values(
    seed().map(({ path, frontmatter }) => ({ vaultId, type: frontmatter.type as string, name: path.slice(path.lastIndexOf('/') + 1), path, frontmatter, body: `Notes on ${path}.` })),
  )
}, 120_000)

afterAll(async () => {
  await agent?.close().catch(() => {})
  await app?.close()
})

describe('browse_vault default answer on a 500-note vault', () => {
  it('is the root level: the 8 folders with their counts, in under 100 tokens', async () => {
    resetRateLimits()
    const result = await agent.callTool({ name: 'browse_vault', arguments: { vaultId } })
    const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
    const tokens = Math.ceil(text.length / 4)
    console.log(`[#425] browse_vault {vaultId} on 500 notes: ${text.length} chars, ${tokens} tokens`)
    expect(result.isError).not.toBe(true)
    expect(tokens).toBeLessThan(100)
    expect(JSON.parse(text)).toMatchObject({ directory: '', notes: [], truncated: false })
  })
})
