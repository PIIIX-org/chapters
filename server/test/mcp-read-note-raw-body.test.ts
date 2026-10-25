// #445 (ADR-004 §2.1): read_note answers its body as plain text. The JSON
// block (`content[0]`) holds every other field, `truncated` last, and in the
// body's place the marker `{"in": "content[1]"}`; `content[1]` is the body
// (a page's slice of it) unescaped, an empty body included; the budget
// counts both blocks. `structuredContent` is the whole object, `body` the
// string, so a client that reads it loses nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { approxTokens } from '../src/mcp/response.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Json = Record<string, unknown>
interface Read {
  blocks: string[]
  json: Json
  structured: Json | undefined
}

/** A body with every character JSON escapes: newlines, CRLF, quotes, backslashes, tabs, and non-ASCII text. */
const TRICKY =
  '# "Quoted" title\n' +
  'A path C:\\Users\\taha\\notes and a regex /\\d+\\.\\w*/\n' +
  'CRLF line one\r\nCRLF line two\r\n' +
  '\ttabbed "and quoted" \'single\' `tick`\n' +
  'Persian: سلام دنیا, Chinese: 你好, emoji: 👋🏽, combining: é\n' +
  '```json\n{"key": "value", "list": ["a", "b"], "nested": {"q": "\\"x\\""}}\n```\n' +
  'no final newline'

/** A realistic note dense in newlines and quotes: short lines, quoted terms, a JSON code block, a table. */
const DENSE = [
  '# Decision: "response contract"',
  '',
  '> "Agents read what we send them." The body is what they pay for.',
  '',
  '## Options',
  '',
  '| option | "cost" | "risk" |',
  '| --- | --- | --- |',
  '| "escaped" | high | none |',
  '| "raw" | low | "clients" |',
  '',
  '```json',
  '{',
  '  "tool": "read_note",',
  '  "args": { "path": "decision/x", "budget_tokens": 4000 },',
  '  "expect": ["path", "rev", "body", "truncated"]',
  '}',
  '```',
  '',
  ...Array.from({ length: 60 }, (_, i) => `- step ${i + 1}: "say ${i}" -> "done"`),
  '',
].join('\n')

/** Short lines, so a small budget pages the body many times. */
const LONG = Array.from({ length: 300 }, (_, i) => `line ${String(i + 1).padStart(3, '0')}: "quoted" \\ back\tslash`).join('\n') + '\n'

let app: FastifyInstance
let vaultId: string
let agent: Client

async function read(args: Json): Promise<Read> {
  resetRateLimits()
  const result = await agent.callTool({ name: 'read_note', arguments: { vaultId, ...args } })
  const content = result.content as Array<{ type: string; text?: string }>
  expect(result.isError, content[0]?.text).not.toBe(true)
  expect(content.every((c) => c.type === 'text')).toBe(true)
  return { blocks: content.map((c) => c.text ?? ''), json: JSON.parse(content[0]!.text ?? '') as Json, structured: result.structuredContent as Json | undefined }
}

/** Characters an answer takes as the budget and the benchmark count them: the blocks joined by a newline. */
const size = (r: Read) => r.blocks.join('\n').length

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'raw body vault' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'raw-body-agent', scope: 'account' } })
  agent = new Client({ name: 'read-note-raw-body-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  await createNote(vaultId, { path: 'docs/tricky', frontmatter: { title: 'Tricky "one"' }, body: TRICKY })
  await createNote(vaultId, { path: 'docs/dense', body: DENSE })
  await createNote(vaultId, { path: 'docs/long', body: LONG })
  await createNote(vaultId, { path: 'docs/empty', body: '' })
}, 180_000)

afterAll(async () => {
  await agent.close().catch(() => {})
  await app.close()
})

describe('read_note: the body as a plain text block', () => {
  it('sends the JSON without the body, then the body exact and unescaped', async () => {
    const r = await read({ path: 'docs/tricky' })
    expect(r.blocks).toHaveLength(2)
    expect(r.blocks[1]).toBe(TRICKY)
    expect(r.json.body).toEqual({ in: 'content[1]' })
    expect(r.json).toMatchObject({ path: 'docs/tricky', frontmatter: { title: 'Tricky "one"' }, truncated: false })
    expect(Object.keys(r.json).at(-1)).toBe('truncated')
    // No body text in the JSON block, escaped or not.
    expect(r.blocks[0]).not.toContain('CRLF line')
    expect(r.blocks[0]).not.toContain(JSON.stringify(TRICKY).slice(1, 20))
  })

  it('keeps the whole object, body included, in structuredContent', async () => {
    const r = await read({ path: 'docs/tricky' })
    expect(r.structured?.body).toBe(TRICKY)
    expect(r.structured).toEqual({ ...r.json, body: TRICKY })
    expect(Object.keys(r.structured!)).toEqual(Object.keys(r.json))
  })

  it('still sends the body block for an empty body', async () => {
    const r = await read({ path: 'docs/empty' })
    expect(r.blocks).toEqual([expect.any(String), ''])
    expect(r.json.body).toEqual({ in: 'content[1]' })
    expect(r.json.truncated).toBe(false)
    expect(r.structured?.body).toBe('')
  })

  it('pages a long body: each slice in block 1, truncated and the cursor in block 0, both blocks within the budget', async () => {
    for (const budget of [256, 600, 1_500]) {
      let text = ''
      let pages = 0
      let cursor: string | null = null
      do {
        const r = await read({ path: 'docs/long', budget_tokens: budget, ...(cursor ? { cursor } : {}) })
        pages++
        expect(r.blocks).toHaveLength(2)
        expect(size(r), `budget ${budget}, page ${pages}`).toBeLessThanOrEqual(budget * 4)
        expect(r.json.body).toEqual({ in: 'content[1]' })
        expect(r.structured?.body).toBe(r.blocks[1])
        const truncated = r.json.truncated as false | { cursor: string | null }
        expect(Object.keys(r.json).at(-1)).toBe('truncated')
        cursor = truncated === false ? null : truncated.cursor
        if (cursor) {
          // Whole lines, and `lines` names them, in the file's numbering (D3): the body starts at body_start_line.
          expect(r.blocks[1]!.endsWith('\n')).toBe(true)
          const first = (r.json.lines as [number, number])[0]
          expect(first).toBe((r.json.body_start_line as number) - 1 + text.split('\n').length)
        }
        text += r.blocks[1]
      } while (cursor && pages < 200)
      expect(pages).toBeGreaterThan(1)
      expect(text).toBe(LONG)
    }
  })

  it('fills a page by raw characters: a budget holds more body than escaped JSON did', async () => {
    const budget = 600
    const r = await read({ path: 'docs/long', budget_tokens: budget })
    const slice = r.blocks[1]!
    // The next whole line would not have fitted, counted raw.
    const next = LONG.slice(slice.length, LONG.indexOf('\n', slice.length) + 1)
    expect(size(r) + next.length).toBeGreaterThan(budget * 4)
    // Escaped, the same slice would not fit the budget.
    expect(r.blocks[0]!.length + JSON.stringify(slice).length).toBeGreaterThan(budget * 4)
  })

  it('measured: a note dense in newlines and quotes costs fewer tokens raw than JSON-escaped', async () => {
    const r = await read({ path: 'docs/dense' })
    expect(r.blocks[1]).toBe(DENSE)
    // The answer before #445: one JSON block with the body as an escaped string in the marker's place.
    const escaped = JSON.stringify(r.structured)
    const raw = r.blocks.join('\n')
    const measured = { escapedTokens: approxTokens(escaped), rawTokens: approxTokens(raw), bodyChars: DENSE.length, escapedBodyChars: JSON.stringify(DENSE).length - 2 }
    console.log(`#445 token comparison on docs/dense: ${JSON.stringify(measured)}`)
    // What is saved: the body's escapes and quotes, less the marker and the newline the benchmark puts between blocks.
    expect(escaped.length - raw.length).toBe(JSON.stringify(DENSE).length - DENSE.length - JSON.stringify({ in: 'content[1]' }).length - 1)
    expect(measured.rawTokens).toBeLessThan(measured.escapedTokens)
  })
})
