// #416 + #417 (ADR-004 §2.1, §2.2): read_note and read_file read parts of a
// document in one call and answer a large one with its outline.
//
// - `targets` (in request order): `{lines: "a-b"}`, `{block: "b_…"}`,
//   `{heading: "A > B"}` and, on read_file, `{symbol: "Class.method"}`. Each
//   comes back as `{<kind>, lines: [a, b], text, next?}`, cut at line
//   boundaries within the budget; `next` names the lines a page did not show
//   and the cursor continues there. A target that names nothing is an item
//   `{<kind>, error: {code: 'NOT_FOUND', …, suggestions}}`; the call succeeds.
// - A read whose whole answer does not fit the budget answers its outline
//   (headings or symbols with `block`, `lines` and `tokens`), with
//   `truncated.level: 'locations'` and a cursor to the body's first page;
//   `outline: true` asks for it, `outline: false` pages the body instead.
// - Note lines count the whole projected file (D3), with `body_start_line`;
//   file answers carry `hash`, both carry `total_lines`.
// - Every read_note answer, ranged or outline, records its rev as the base
//   a later whole-body edit merges from (#864, #961).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { mcpConnections, noteReads, notes, repositoryFiles } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote, updateNote } from '../src/notes/store.js'
import { noteBlocks } from '../src/notes/note-blocks.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Json = Record<string, unknown>
type Truncated = false | { shown: Record<string, number>; total: Record<string, number | string>; dropped: Record<string, number>; level: string; cursor: string | null; narrow: string[] }
type Answer = Json & { truncated: Truncated }
interface Part {
  lines?: [number, number]
  text?: string
  next?: string
  block?: string
  heading?: string
  symbol?: string
  error?: { code: string; message: string; suggestions?: string[] }
}
interface OutlineEntry {
  block: string
  heading?: string
  symbol?: string
  kind?: string
  lines: [number, number]
  tokens: number
}

let app: FastifyInstance
let baseUrl: string
let vaultId: string
let repoId: string
let ownerId: string
let agent: Client
let agentConnectionId: string
const clients: Client[] = []

const GUIDE = [
  'Intro paragraph.',
  '',
  '# Setup',
  'Install it.',
  '## Linux',
  'apt install x',
  '## macOS',
  'brew install x',
  '# Usage',
  'Run it.',
  '## Flags',
  '--verbose',
  '',
].join('\n')

/** 30 sections of 31 lines (each under the 2,000-character chunk, so one block): ~11k tokens, an outline of 31 entries. */
const HANDBOOK =
  'The handbook.\n\n' +
  Array.from({ length: 30 }, (_, i) => [`## Chapter ${i + 1}`, ...Array.from({ length: 30 }, (_, j) => `Chapter ${i + 1}, line ${j + 1}: ${'words '.repeat(4)}`)].join('\n')).join('\n') +
  '\n'

const STORE_TS = [
  'export class Store {',
  '  save(x: string) {',
  '    return x',
  '  }',
  '  load() {',
  '    return 1',
  '  }',
  '}',
  'export function helper() {',
  '  return 2',
  '}',
  '',
].join('\n')

/** 60 functions of 42 lines: ~31k tokens, an outline of 60 symbols. */
const BIG_TS = Array.from({ length: 60 }, (_, i) =>
  [
    `export function fn${i}(input: number): number {`,
    `  const a${i} = input + ${i}`,
    ...Array.from({ length: 38 }, (_, j) => `  // line ${j + 1} of fn${i}: filler text to make it long`),
    `  return a${i}`,
    '}',
  ].join('\n'),
).join('\n')

const README_MD = ['# Project', 'About it.', '## Install', 'npm i', '## Use', 'run it', ''].join('\n')

/** Lines a..b (1-based, inclusive) of `text`, each with its line break. */
function linesOf(text: string, a: number, b: number): string {
  const lines = text.split(/(?<=\n)/)
  return lines.slice(a - 1, b).join('')
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'read-targets-test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return client
}

/** One answer: the JSON with read_note's top-level body block put back in its key, and every block's characters as the budget counts them. */
async function call(tool: string, args: Json): Promise<{ isError: boolean; json: Answer; chars: number; text: string }> {
  resetRateLimits()
  const result = await agent.callTool({ name: tool, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  const texts = content.map((c) => c.text ?? '')
  let json: Answer
  try {
    json = JSON.parse(texts[0]!) as Answer
  } catch {
    json = { truncated: false }
  }
  const body = json.body as { in?: string } | undefined
  if (body && typeof body === 'object' && body.in === 'content[1]') json.body = texts[1]
  return { isError: result.isError === true, json, chars: texts.join('\n').length, text: texts[0] ?? '' }
}

/** A successful answer within its budget, `truncated` last. */
async function read(tool: 'read_note' | 'read_file', args: Json): Promise<Answer> {
  const r = await call(tool, { ...(tool === 'read_note' ? { vaultId } : { repositoryId: repoId }), ...args })
  expect(r.isError, `${tool} ${JSON.stringify(args).slice(0, 200)}: ${r.text.slice(0, 300)}`).toBe(false)
  const budget = typeof args.budget_tokens === 'number' ? args.budget_tokens : 4_000
  expect(Math.ceil(r.chars / 4), `${tool} answer of ${r.chars} chars over ${budget} tokens`).toBeLessThanOrEqual(budget)
  expect(Object.keys(r.json).at(-1)).toBe('truncated')
  return r.json
}

const parts = (a: Answer) => a.targets as Part[]
const cursorOf = (a: Answer) => (a.truncated === false ? null : a.truncated.cursor)
/** The section index a cursor resumes at (base64url JSON `{k: {s, p}}`, response.ts). */
const sectionOf = (cursor: string) => (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { k: { s: number } }).k.s

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  ownerId = owner.id
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'targets vault' } })).json<{ id: string }>().id
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'targets-repo', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'targets-agent', scope: 'account' } })
  agent = await mcpClient(minted.json<{ token: string }>().token)
  agentConnectionId = (await db.select({ id: mcpConnections.id }).from(mcpConnections).where(eq(mcpConnections.name, 'targets-agent')))[0]!.id

  await createNote(vaultId, { path: 'docs/guide', frontmatter: { title: 'Guide', tags: ['a', 'b'] }, body: GUIDE })
  await createNote(vaultId, { path: 'docs/handbook', body: HANDBOOK })
  const files = [
    { path: 'src/store.ts', content: STORE_TS },
    { path: 'src/big.ts', content: BIG_TS },
    { path: 'docs/README.md', content: README_MD },
  ]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await flushExtraction()
}, 180_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

/** A note's `body_start_line` (D3: line 1 is `---`) and id. */
async function noteFile(path: string): Promise<{ bodyStart: number; id: string }> {
  const whole = await read('read_note', { path, outline: false, budget_tokens: 25_000 })
  const [row] = await db.select({ id: notes.id }).from(notes).where(and(eq(notes.vaultId, vaultId), eq(notes.path, path)))
  return { bodyStart: whole.body_start_line as number, id: row!.id }
}

describe('read_note targets (#416)', () => {
  it('counts lines over the whole file (D3): body_start_line, total_lines, and lines targets in file numbering', async () => {
    const { bodyStart } = await noteFile('docs/guide')
    // `---`, title, tags: [a, b] as a block list (3 lines), `---`.
    expect(bodyStart).toBeGreaterThan(3)
    const a = await read('read_note', { path: 'docs/guide', targets: [{ lines: `${bodyStart + 2}-${bodyStart + 3}` }, { lines: '1' }] })
    expect(a).toMatchObject({ path: 'docs/guide', rev: expect.any(Number), body_start_line: bodyStart, total_lines: bodyStart - 1 + 12 })
    expect(a).not.toHaveProperty('body')
    expect(parts(a)).toEqual([
      { lines: [bodyStart + 2, bodyStart + 3], text: '# Setup\nInstall it.\n' },
      { lines: [1, 1], text: '---\n' },
    ])
    expect(a.truncated).toBe(false)
  })

  it('reads a heading section (path or last title) and a block id, the same ids the blocks table uses', async () => {
    const { bodyStart, id } = await noteFile('docs/guide')
    const blocks = noteBlocks(id, 'docs/guide', GUIDE)
    const linux = blocks.find((b) => b.innerPath === 'Setup > Linux')!
    const a = await read('read_note', { path: 'docs/guide', targets: [{ heading: 'Setup > Linux' }, { heading: 'macos' }, { block: linux.blockId }, { heading: 'Usage' }] })
    const at = (n: number) => bodyStart - 1 + n
    expect(parts(a)).toEqual([
      { heading: 'Setup > Linux', lines: [at(5), at(6)], text: '## Linux\napt install x\n' },
      { heading: 'Setup > macOS', lines: [at(7), at(8)], text: '## macOS\nbrew install x\n' },
      { block: linux.blockId, lines: [at(5), at(6)], text: '## Linux\napt install x\n' },
      // A section runs through its subsections, to the next heading of its level.
      { heading: 'Usage', lines: [at(9), at(12)], text: '# Usage\nRun it.\n## Flags\n--verbose\n' },
    ])
  })

  it('answers a missing heading or block with NOT_FOUND and suggestions per target; the rest is served', async () => {
    const r = await call('read_note', { vaultId, path: 'docs/guide', targets: [{ heading: 'Setpu > Linux' }, { lines: '1-1' }, { block: 'b_aaaaaaaaaaaa' }, { lines: '9999' }] })
    expect(r.isError, r.text).toBe(false)
    const [heading, lines, block, past] = parts(r.json)
    expect(heading).toMatchObject({ heading: 'Setpu > Linux', error: { code: 'NOT_FOUND', retryable: false } })
    expect(heading!.error!.suggestions?.[0]).toBe('Setup > Linux')
    expect(heading).not.toHaveProperty('text')
    expect(lines).toEqual({ lines: [1, 1], text: '---\n' })
    expect(block).toMatchObject({ block: 'b_aaaaaaaaaaaa', error: { code: 'NOT_FOUND' } })
    expect(past).toMatchObject({ lines: '9999', error: { code: 'NOT_FOUND' } })
  })

  it('refuses a target that names no or several kinds, and outline with targets', async () => {
    for (const targets of [[{}], [{ lines: '1', heading: 'Usage' }]]) {
      const r = await call('read_note', { vaultId, path: 'docs/guide', targets })
      expect(r.isError, r.text).toBe(false)
      expect(parts(r.json)[0]).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } })
    }
    const both = await call('read_note', { vaultId, path: 'docs/guide', targets: [{ lines: '1' }], outline: true })
    expect(both.isError).toBe(true)
    expect(both.text).toContain('INVALID_ARGUMENT')
    // 1 to 20 targets; the budget's range is checked though tools/list no longer lists it as minimum/maximum.
    for (const args of [{ targets: [] }, { targets: Array.from({ length: 21 }, () => ({ lines: '1' })) }, { budget_tokens: 255 }, { budget_tokens: 25_001 }, { budget_tokens: 1_000.5 }]) {
      const r = await call('read_note', { vaultId, path: 'docs/guide', ...args })
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(r.text).toContain('INVALID_ARGUMENT')
    }
  })
})

describe('read_file targets (#416)', () => {
  it('reads symbols, lines, blocks and markdown headings, in request order, with hash and total_lines', async () => {
    const outline = await read('read_file', { path: 'src/store.ts', outline: true })
    const entries = outline.outline as OutlineEntry[]
    expect(entries.map((e) => e.symbol)).toEqual(['Store', 'Store.save', 'Store.load', 'helper'])
    const save = entries.find((e) => e.symbol === 'Store.save')!
    expect(save).toMatchObject({ kind: 'method', lines: [2, 4], block: expect.stringMatching(/^b_[a-z2-7]{12}$/), tokens: expect.any(Number) })

    const a = await read('read_file', { path: 'src/store.ts', targets: [{ symbol: 'Store.save' }, { lines: '9-11' }, { block: save.block }, { symbol: 'load' }] })
    const [hash] = await db.select({ h: repositoryFiles.contentHash }).from(repositoryFiles).where(and(eq(repositoryFiles.repositoryId, repoId), eq(repositoryFiles.path, 'src/store.ts')))
    expect(a).toMatchObject({ path: 'src/store.ts', hash: hash!.h.slice(0, 16), total_lines: 11 })
    expect(a).not.toHaveProperty('content')
    expect(parts(a)).toEqual([
      { symbol: 'Store.save', lines: [2, 4], text: linesOf(STORE_TS, 2, 4) },
      { lines: [9, 11], text: linesOf(STORE_TS, 9, 11) },
      { block: save.block, lines: [2, 4], text: linesOf(STORE_TS, 2, 4) },
      { symbol: 'Store.load', lines: [5, 7], text: linesOf(STORE_TS, 5, 7) },
    ])

    const md = await read('read_file', { path: 'docs/README.md', targets: [{ heading: 'Project > Use' }, { heading: 'install' }] })
    expect(parts(md)).toEqual([
      { heading: 'Project > Use', lines: [5, 6], text: '## Use\nrun it\n' },
      { heading: 'Project > Install', lines: [3, 4], text: '## Install\nnpm i\n' },
    ])
  })

  it('answers a missing symbol with NOT_FOUND and the nearest symbols; a heading on code is not found', async () => {
    const r = await call('read_file', { repositoryId: repoId, path: 'src/store.ts', targets: [{ symbol: 'Store.sav' }, { heading: 'Store' }, { lines: '1' }] })
    expect(r.isError, r.text).toBe(false)
    const [symbol, heading, lines] = parts(r.json)
    expect(symbol).toMatchObject({ symbol: 'Store.sav', error: { code: 'NOT_FOUND' } })
    expect(symbol!.error!.suggestions?.[0]).toBe('Store.save')
    expect(heading).toMatchObject({ heading: 'Store', error: { code: 'NOT_FOUND' } })
    expect(lines).toEqual({ lines: [1, 1], text: 'export class Store {\n' })
  })
})

describe('outline instead of a large body (#417)', () => {
  it('read_note: a body over the budget answers its outline, the cursor pages the body from its first line', async () => {
    const { bodyStart, id } = await noteFile('docs/handbook')
    const a = await read('read_note', { path: 'docs/handbook' })
    expect(a).not.toHaveProperty('body')
    expect(a).toMatchObject({ path: 'docs/handbook', rev: expect.any(Number), body_start_line: bodyStart, frontmatter: expect.any(Object) })
    const entries = a.outline as OutlineEntry[]
    const blocks = noteBlocks(id, 'docs/handbook', HANDBOOK)
    expect(entries).toHaveLength(31)
    expect(entries.map((e) => e.block)).toEqual(blocks.map((b) => b.blockId))
    expect(entries[0]).toEqual({ block: blocks[0]!.blockId, lines: [bodyStart, bodyStart + 1], tokens: expect.any(Number) })
    expect(entries[1]).toMatchObject({ heading: 'Chapter 1', lines: [bodyStart + 2, bodyStart + 32] })
    // About what reading it costs: 31 lines of ~47 characters.
    expect(entries[1]!.tokens).toBeGreaterThan(300)
    expect(entries[1]!.tokens).toBeLessThan(450)
    expect(a.truncated).toMatchObject({ level: 'locations', shown: { outline: 31, body: 0 }, dropped: { body: 30 * 31 + 2 }, cursor: expect.any(String) })

    const first = await read('read_note', { path: 'docs/handbook', cursor: cursorOf(a) })
    expect(first).not.toHaveProperty('outline')
    expect(HANDBOOK.startsWith(first.body as string)).toBe(true)
    expect((first.lines as number[])[0]).toBe(bodyStart)

    // `outline: false` pages the body; `outline: true` outlines a note that fits.
    const paged = await read('read_note', { path: 'docs/handbook', outline: false })
    expect(paged.body).toBe(first.body)
    expect(paged.lines).toEqual(first.lines)
    const small = await read('read_note', { path: 'docs/guide', outline: true })
    expect((small.outline as OutlineEntry[]).map((e) => e.heading ?? '')).toEqual(['', 'Setup', 'Setup > Linux', 'Setup > macOS', 'Usage', 'Usage > Flags'])
    // A note that fits comes back whole, as before.
    const whole = await read('read_note', { path: 'docs/guide' })
    expect(whole).toMatchObject({ body: GUIDE, truncated: false })
    expect(whole).not.toHaveProperty('outline')
  })

  it('read_file: a file over the budget answers its symbol outline, the cursor pages the content from line 1', async () => {
    const a = await read('read_file', { path: 'src/big.ts' })
    expect(a).not.toHaveProperty('content')
    expect(a).not.toHaveProperty('symbols')
    const entries = a.outline as OutlineEntry[]
    expect(entries).toHaveLength(60)
    expect(entries[10]).toEqual({ block: expect.stringMatching(/^b_/), symbol: 'fn10', kind: 'function', lines: [421, 462], tokens: expect.any(Number) })
    expect(a).toMatchObject({ total_lines: 2_520, hash: expect.stringMatching(/^[0-9a-f]{16}$/) })
    expect(a.truncated).toMatchObject({ level: 'locations', shown: { outline: 60, content: 0 }, dropped: { content: 2_520 }, cursor: expect.any(String) })
    const first = await read('read_file', { path: 'src/big.ts', cursor: cursorOf(a) })
    expect(BIG_TS.startsWith(first.content as string)).toBe(true)
    expect((first.lines as number[])[0]).toBe(1)

    const fn10 = await read('read_file', { path: 'src/big.ts', targets: [{ block: entries[10]!.block }] })
    expect(parts(fn10)).toEqual([{ block: entries[10]!.block, lines: [421, 462], text: linesOf(BIG_TS, 421, 462) }])
  })
})

describe('the budget holds for targets', () => {
  it('cuts targets at line boundaries with `next`, continues with the cursor, never over the budget', async () => {
    const targets = [{ symbol: 'fn3' }, { lines: '1-300' }, { symbol: 'fn40' }, { symbol: 'nope' }, { lines: '2500-2520' }]
    const expected = [linesOf(BIG_TS, 127, 168), linesOf(BIG_TS, 1, 300), linesOf(BIG_TS, 1681, 1722), null, linesOf(BIG_TS, 2500, 2520)]
    for (const budget of [256, 400, 700, 1_500, 4_000, 25_000]) {
      const got: string[] = targets.map(() => '')
      let at = 0
      let cursor: string | null = null
      let pages = 0
      do {
        const a = await read('read_file', { path: 'src/big.ts', targets, budget_tokens: budget, ...(cursor ? { cursor } : {}) })
        pages++
        expect(pages, `budget ${budget}`).toBeLessThan(200)
        for (const [i, part] of parts(a).entries()) {
          if (part.text === undefined) continue
          const n = at + i
          got[n] += part.text
          const [a0, b0] = part.lines!
          // `lines` names exactly what `text` holds; `next` the rest of the target.
          expect(part.text.split(/(?<=\n)/).length, `budget ${budget}`).toBe(b0 - a0 + 1)
          if (part.next) expect(Number(part.next.split('-')[0])).toBe(b0 + 1)
        }
        cursor = cursorOf(a)
        if (cursor) at = sectionOf(cursor)
      } while (cursor)
      expect(got.map((t, i) => (expected[i] === null ? null : t)), `budget ${budget}`).toEqual(expected)
      if (budget <= 1_500) expect(pages, `budget ${budget}`).toBeGreaterThan(1)
    }
  })

  it('read_note targets and outline stay within small budgets too', async () => {
    for (const budget of [256, 512, 1_000]) {
      const outline = await read('read_note', { path: 'docs/handbook', budget_tokens: budget })
      expect(outline.truncated).not.toBe(false)
      const ranged = await read('read_note', { path: 'docs/handbook', targets: [{ heading: 'Chapter 7' }, { heading: 'Chapter 9' }], budget_tokens: budget })
      expect(parts(ranged)[0]!.lines![0]).toBeGreaterThan(1)
    }
  })
})

describe('a ranged read is a merge base (#864, #961)', () => {
  it('targets read, a person edits another section, the agent sends its whole body: both edits are kept', async () => {
    const path = 'docs/merge'
    const base = '# Alpha\nalpha text\n# Beta\nbeta text\n'
    await createNote(vaultId, { path, body: base })
    const a = await read('read_note', { path, targets: [{ heading: 'Alpha' }] })
    expect(parts(a)[0]).toMatchObject({ heading: 'Alpha', text: '# Alpha\nalpha text\n' })
    const [recorded] = await db
      .select({ rev: noteReads.rev })
      .from(noteReads)
      .innerJoin(notes, eq(notes.id, noteReads.noteId))
      .where(and(eq(noteReads.connectionId, agentConnectionId), eq(notes.vaultId, vaultId), eq(notes.path, path)))
    expect(recorded).toEqual({ rev: a.rev })

    await updateNote(vaultId, path, { body: '# Alpha\nalpha text\n# Beta\nbeta text, edited by a person\n' }, { type: 'user', id: ownerId })
    const edit = await call('edit_note', { vaultId, path, body: '# Alpha\nalpha text, edited by the agent\n# Beta\nbeta text\n' })
    expect(edit.isError, edit.text).toBe(false)
    expect(edit.json).toMatchObject({ status: 'merged', baseRev: a.rev, body: '# Alpha\nalpha text, edited by the agent\n# Beta\nbeta text, edited by a person\n' })
  })

  it('an outline read records its rev too', async () => {
    const a = await read('read_note', { path: 'docs/handbook' })
    expect(a).toHaveProperty('outline')
    const [recorded] = await db
      .select({ rev: noteReads.rev })
      .from(noteReads)
      .innerJoin(notes, eq(notes.id, noteReads.noteId))
      .where(and(eq(noteReads.connectionId, agentConnectionId), eq(notes.vaultId, vaultId), eq(notes.path, 'docs/handbook')))
    expect(recorded).toEqual({ rev: a.rev })
  })
})

describe('suggestions stay bounded', () => {
  it('20 missing long heading targets on a note of 2,000 headings answer quickly, with suggestions where the work allows', async () => {
    const path = 'docs/many-headings'
    const body = Array.from({ length: 2_000 }, (_, i) => `## Heading number ${i} about ${'topic '.repeat(6)}\ntext ${i}\n`).join('')
    await createNote(vaultId, { path, body })
    const targets = Array.from({ length: 20 }, (_, i) => ({ heading: `Missing heading ${i} ${'x'.repeat(100)}` }))
    const started = performance.now()
    const r = await call('read_note', { vaultId, path, targets, budget_tokens: 25_000 })
    const ms = performance.now() - started
    expect(r.isError, r.text.slice(0, 200)).toBe(false)
    expect(parts(r.json).every((p) => p.error?.code === 'NOT_FOUND')).toBe(true)
    // Unbounded, this read ran an edit distance per target against every heading: seconds of a blocked event loop.
    expect(ms).toBeLessThan(2_000)
    // A short miss still gets its nearest headings.
    const near = await call('read_note', { vaultId, path, targets: [{ heading: 'Heading numbr 7 about topic topic topic topic topic topic' }] })
    expect(parts(near.json)[0]!.error!.suggestions?.length).toBeGreaterThan(0)
  })
})
