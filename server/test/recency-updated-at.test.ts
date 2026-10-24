import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

// #446, owner decision D9 (#930): recency is the note's last change
// (`notes.updated_at`), not frontmatter `timestamp`, which stays the creation
// time. `since`/`until` of search and graph filter on it, every edit path
// moves it, a write that changes nothing does not.

type Args = Record<string, unknown>

let app: FastifyInstance
let collab: CollabRelay
let baseUrl: string
let cookie: string
let token: string
let vaultId: string
let mcp: Client
const providers: HocuspocusProvider[] = []

const CREATED = '2020-01-01T00:00:00Z'
const UNTIL_2021 = '2021-01-01T00:00:00Z'

async function must<T>(name: string, args: Args): Promise<T> {
  resetRateLimits()
  const result = await mcp.callTool({ name, arguments: args })
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
  if (result.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text) as T
}

async function waitFor(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** A note written in 2020: frontmatter `timestamp` and `updated_at` both then, `word` its only keyword. */
async function oldNote(path: string, word: string): Promise<string> {
  const { id } = await must<{ id: string }>('create_note', { vaultId, path, frontmatter: { timestamp: CREATED }, body: `The ${word} entry.\n` })
  await age(id)
  return id
}

async function age(id: string): Promise<void> {
  await db.execute(sql`UPDATE notes SET updated_at = ${CREATED}::timestamptz WHERE id = ${id}`)
}

async function row(id: string): Promise<{ body: string; timestamp: unknown; updatedAt: string }> {
  const [r] = (await db.execute(sql`
    SELECT body, frontmatter->'timestamp' AS timestamp, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM notes WHERE id = ${id}`)) as unknown as Array<{ body: string; timestamp: unknown; updated_at: string }>
  return { body: r!.body, timestamp: r!.timestamp, updatedAt: r!.updated_at }
}

const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString()

async function searchPaths(word: string, qs: string): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/search?q=${word}&${qs}`, headers: { cookie } })
  expect(res.statusCode).toBe(200)
  return res.json<{ results: Array<{ path: string }> }>().results.map((r) => r.path)
}

async function graphPaths(qs: string): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/graph?${qs}`, headers: { cookie } })
  expect(res.statusCode).toBe(200)
  return res.json<{ nodes: Array<{ path: string }> }>().nodes.map((n) => n.path)
}

/** Where `since` an hour ago and `until` 2021 put the note, in search and in the graph. */
async function recency(path: string, word: string) {
  const since = `since=${encodeURIComponent(hourAgo())}`
  const until = `until=${encodeURIComponent(UNTIL_2021)}`
  return {
    searchSince: (await searchPaths(word, since)).includes(path),
    searchUntil: (await searchPaths(word, until)).includes(path),
    graphSince: (await graphPaths(since)).includes(path),
    graphUntil: (await graphPaths(until)).includes(path),
  }
}

const OLD = { searchSince: false, searchUntil: true, graphSince: false, graphUntil: true }
const RECENT = { searchSince: true, searchUntil: false, graphSince: true, graphUntil: false }

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  token = await loginToken(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Recency vault' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'recency', scope: 'account' } })
  mcp = new Client({ name: 'recency-test', version: '0.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await mcp.close()
  await collab.destroy()
  await app.close()
})

describe('since/until and recency use updated_at (#446)', () => {
  it('an MCP edit_note makes a 2020 note recent to search and graph; its frontmatter timestamp stays', async () => {
    const path = 'docs/quokka-mcp'
    const id = await oldNote(path, 'quokka')
    expect(await recency(path, 'quokka')).toEqual(OLD)

    await must('edit_note', { vaultId, path, body: 'The quokka entry, edited.\n' })

    expect(await recency(path, 'quokka')).toEqual(RECENT)
    const after = await row(id)
    expect(after.timestamp).toBe(CREATED)
    expect(after.updatedAt >= hourAgo()).toBe(true)
  })

  it('a REST update does the same', async () => {
    const path = 'docs/wombat-rest'
    const id = await oldNote(path, 'wombat')
    expect(await recency(path, 'wombat')).toEqual(OLD)

    const put = await app.inject({ method: 'PUT', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie }, body: { body: 'The wombat entry, edited.\n' } })
    expect(put.statusCode).toBe(200)

    expect(await recency(path, 'wombat')).toEqual(RECENT)
    expect((await row(id)).timestamp).toBe(CREATED)
  })

  it('upsert_note and rename_note move updated_at, not timestamp', async () => {
    const id = await oldNote('docs/numbat-upsert', 'numbat')
    await must('upsert_note', { vaultId, path: 'docs/numbat-upsert', body: 'The numbat entry, upserted.\n' })
    expect((await row(id)).updatedAt >= hourAgo()).toBe(true)

    await age(id)
    await must('rename_note', { vaultId, from: 'docs/numbat-upsert', toName: 'numbat-renamed' })
    const renamed = await row(id)
    expect(renamed.updatedAt >= hourAgo()).toBe(true)
    expect(renamed.timestamp).toBe(CREATED)
  })

  it('a write that changes nothing leaves updated_at', async () => {
    const path = 'docs/bilby-noop'
    const id = await oldNote(path, 'bilby')
    const body = (await row(id)).body
    await must('edit_note', { vaultId, path, body })
    const put = await app.inject({ method: 'PUT', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie }, body: { body } })
    expect(put.statusCode).toBe(200)
    expect((await row(id)).updatedAt).toBe('2020-01-01T00:00:00.000Z')
  })

  it("a fold of a person's typing moves updated_at", async () => {
    const path = 'docs/dingo-typed'
    const id = await oldNote(path, 'dingo')
    const provider = new HocuspocusProvider({ url: `${baseUrl.replace('http', 'ws')}/collab`, name: `${vaultId}/~${id}`, token, document: new Y.Doc() })
    providers.push(provider)
    const text = provider.document.getText('body')
    await waitFor(async () => provider.isSynced && text.length > 0)
    // Loading the note for the editor writes nothing to the row.
    expect((await row(id)).updatedAt).toBe('2020-01-01T00:00:00.000Z')

    text.insert(text.length, 'Typed in the editor.\n')
    await waitFor(async () => (await row(id)).body.includes('Typed in the editor.'))

    const folded = await row(id)
    expect(folded.updatedAt >= hourAgo()).toBe(true)
    expect(folded.timestamp).toBe(CREATED)
    expect(await recency(path, 'dingo')).toEqual(RECENT)
  })

  it('search hits carry the day of the last change as `updated`, over REST and MCP', async () => {
    const id = await oldNote('docs/echidna-hit', 'echidna')
    const rest = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/search?q=echidna`, headers: { cookie } })
    const hit = rest.json<{ results: Array<{ id: string; updated?: string }> }>().results.find((r) => r.id === id)
    expect(hit?.updated).toBe('2020-01-01')

    const viaMcp = await must<{ results: Array<Record<string, unknown>> }>('search', { vaultId, query: 'echidna' })
    const mcpHit = viaMcp.results.find((r) => r.id === id)
    expect(mcpHit?.updated).toBe('2020-01-01')
    expect(mcpHit).not.toHaveProperty('updatedAt')
  })

  it('search and graph agree on a change inside the millisecond of a bound', async () => {
    const path = 'docs/kowari-edge'
    const id = await oldNote(path, 'kowari')
    // 500 µs past the millisecond: both compare at millisecond precision, so the change is at the bound.
    await db.execute(sql`UPDATE notes SET updated_at = '2024-05-01T12:00:00.000500Z'::timestamptz WHERE id = ${id}`)
    const at = encodeURIComponent('2024-05-01T12:00:00.000Z')
    const after = encodeURIComponent('2024-05-01T12:00:00.001Z')
    for (const qs of [`since=${at}`, `until=${at}`, `since=${at}&until=${at}`]) {
      expect((await searchPaths('kowari', qs)).includes(path), qs).toBe(true)
      expect((await graphPaths(qs)).includes(path), qs).toBe(true)
    }
    expect((await searchPaths('kowari', `since=${after}`)).includes(path)).toBe(false)
    expect((await graphPaths(`since=${after}`)).includes(path)).toBe(false)
  })
})
