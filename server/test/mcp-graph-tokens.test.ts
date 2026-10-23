// #426's measured token figure: `graph {vaultId}`, the default answer, on a
// seeded 500-note vault shaped like a working vault (8 type folders, tags,
// two wikilinks per note; no embeddings, so no semantic edges). Note ids and
// timestamps are fixed: Louvain is seeded from the node ids and fed in id
// order (#816), so random ids gave a different partition, and a different
// figure, on every run (1,863-2,357 tokens over 5 runs). Tokens are
// characters / 4, the premise benchmark's estimate. The call takes only
// `vaultId` (and follows `truncated.cursor`), so this file runs unchanged on
// code from before #426 to give the "before" figure: it prints the figures
// there and fails its bound.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteLinks, notes } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let agent: Client
let vaultId: string

const FOLDERS: Array<[string, number]> = [
  ['fixes', 120],
  ['decision', 60],
  ['audit', 70],
  ['research', 80],
  ['meeting', 50],
  ['project', 40],
  ['person', 30],
  ['howto', 50],
]
const WORDS = ['budget', 'cursor', 'graph', 'search', 'vault', 'index', 'token', 'paging', 'review', 'schema', 'backup', 'restore']

/** 500 notes, each linking to the next note of its folder and to one note of the next folder; the same on every run. */
function seed(): { rows: Array<{ path: string; type: string; tags: string[] }>; links: Array<[number, string]> } {
  const rows: Array<{ path: string; type: string; tags: string[] }> = []
  for (const [type, count] of FOLDERS) {
    for (let i = 0; i < count; i++) {
      const words = [0, 1, 2].map((k) => WORDS[(i * 7 + k * 5) % WORDS.length]!)
      rows.push({ path: `${type}/${words.slice(0, 2).join('-')}-${String(i).padStart(3, '0')}`, type, tags: words.slice(0, 1 + (i % 2)) })
    }
  }
  const links: Array<[number, string]> = []
  let start = 0
  for (const [f, [, count]] of FOLDERS.entries()) {
    const nextStart = (start + count) % rows.length
    const nextCount = FOLDERS[(f + 1) % FOLDERS.length]![1]
    for (let i = 0; i < count; i++) {
      links.push([start + i, rows[start + ((i + 1) % count)]!.path])
      links.push([start + i, rows[nextStart + ((i * 3) % nextCount)]!.path])
    }
    start += count
  }
  return { rows, links }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'graph tokens' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'graph-tokens-agent', scope: 'account' } })
  agent = new Client({ name: 'graph-tokens-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  // The rows only: the graph reads nothing else (no file, projection or embedding needed).
  const { rows, links } = seed()
  const inserted = await db
    .insert(notes)
    .values(
      rows.map(({ path, type, tags }, i) => ({
        // Fixed per note; the test database is created afresh for every run, and no other file uses this prefix.
        id: `42600000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        vaultId,
        type,
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        frontmatter: { type, title: path, tags, timestamp: '2026-10-01T00:00:00.000Z' },
        body: `Notes on ${path}.`,
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      })),
    )
    .returning({ id: notes.id, path: notes.path })
  const idOf = new Map(inserted.map((r) => [r.path, r.id]))
  await db.insert(noteLinks).values(links.map(([source, targetPath]) => ({ sourceNoteId: idOf.get(rows[source]!.path)!, targetPath })))
}, 120_000)

afterAll(async () => {
  await agent?.close().catch(() => {})
  await app?.close()
})

describe('graph default answer on a 500-note vault', () => {
  it('is the community view: one page under 1,000 tokens, against ~342k tokens for the node list before #426', async () => {
    let first = 0
    let total = 0
    let pages = 0
    let json: { aggregated?: boolean; nodes: unknown[]; truncated: false | { cursor: string | null } } | undefined
    let cursor: string | null = null
    do {
      resetRateLimits()
      const result = await agent.callTool({ name: 'graph', arguments: { vaultId, ...(cursor ? { cursor } : {}) } })
      const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
      expect(result.isError, text.slice(0, 200)).not.toBe(true)
      const tokens = Math.ceil(text.length / 4)
      if (pages === 0) first = tokens
      total += tokens
      pages++
      json = JSON.parse(text) as typeof json
      cursor = json!.truncated === false ? null : json!.truncated.cursor
    } while (cursor !== null && pages < 1_000)
    console.log(`[#426] graph {vaultId} on 500 notes: first page ${first} tokens; whole default answer ${total} tokens in ${pages} pages`)
    expect(json!.aggregated).toBe(true)
    // Before #426 (the node list, 500 nodes and ~3,700 edges): 342,218 tokens in 173 pages.
    // With these fixed ids: 857 tokens, one page.
    expect(pages).toBe(1)
    expect(total).toBeLessThan(1_000)
  })
})
