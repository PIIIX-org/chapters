// #472: a wikilink row keeps a short context (its paragraph, or its line, at
// most 200 code points), and agents ask "who links to this note, where"
// through `graph {neighborsOf}`: its `backlinks` list every stored link to
// the centre as `{path, location: "path#La", context}`, lines of the
// projected `.md` file of the linking note, inside the budget envelope.
// Body edits move the rows; a frontmatter-only edit leaves them as they are
// (body-relative, ADR-004 §2.2) while the locations follow the file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { readFile } from 'node:fs/promises'
import { asc, eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteLinks } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { extractWikilinkLocations } from '../src/notes/okf.js'
import { flushProjections } from '../src/notes/projector.js'
import { createNote, noteFile } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
type Truncated = false | { shown: Record<string, number>; total: Record<string, number | string>; dropped: Record<string, number>; level: string; cursor: string | null }
type Answer = Record<string, unknown> & { truncated: Truncated }
interface Backlink {
  path: string
  location: string
  context: string | null
}

const codePoints = (s: string) => [...s].length
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('wikilink context (#472)', () => {
  it("is the link's paragraph: the non-blank lines around it", () => {
    const body = ['# Title', '', 'First line of the paragraph', 'with [[ctx/a]] inside', 'and a last line.', '', 'Other [[ctx/b]].'].join('\n')
    expect(extractWikilinkLocations(body).map((l) => [l.target, l.startLine, l.context])).toEqual([
      ['ctx/a', 4, 'First line of the paragraph\nwith [[ctx/a]] inside\nand a last line.'],
      ['ctx/b', 7, 'Other [[ctx/b]].'],
    ])
  })

  it('is the link line when the paragraph is over 200 code points, and a window around the link when the line is', () => {
    const filler = 'word '.repeat(50).trim()
    const body = [filler, 'The [[ctx/line]] line.', filler, '', `${filler} [[ctx/window]] ${filler}`].join('\n')
    const [line, window] = extractWikilinkLocations(body)
    expect(line!.context).toBe('The [[ctx/line]] line.')
    expect(window!.context).toContain('[[ctx/window]]')
    expect(window!.context!.startsWith('…')).toBe(true)
    expect(window!.context!.endsWith('…')).toBe(true)
    expect(codePoints(window!.context!)).toBe(200)
  })

  it('is cut on code points: never more than 200 of them, never half a surrogate pair', () => {
    for (const shift of [0, 1, 2, 3]) {
      const body = `${'x'.repeat(shift)}${'😀'.repeat(300)} [[ctx/astral]] ${'𝄞'.repeat(300)}`
      const [link] = extractWikilinkLocations(body)
      expect(link!.context).toContain('[[ctx/astral]]')
      expect(codePoints(link!.context!)).toBeLessThanOrEqual(200)
      expect(link!.context).not.toMatch(LONE_SURROGATE)
    }
  })

  it('keeps the CRLF body lines without their carriage returns', () => {
    const [link] = extractWikilinkLocations('one\r\ntwo [[ctx/crlf]]\r\n\r\nthree')
    expect(link).toMatchObject({ startLine: 2, context: 'one\ntwo [[ctx/crlf]]' })
  })
})

let app: FastifyInstance
let agent: Client
let cookie: string
let vaultId: string

async function call(name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await agent.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

/** One answer within its budget, `truncated` last. */
async function graph(args: Args): Promise<Answer> {
  const r = await call('graph', { vaultId, ...args })
  expect(r.isError, `graph ${JSON.stringify(args)}: ${r.text.slice(0, 300)}`).toBe(false)
  expect(Math.ceil(r.text.length / 4)).toBeLessThanOrEqual(typeof args.budget_tokens === 'number' ? args.budget_tokens : 2_000)
  const json = JSON.parse(r.text) as Answer
  expect(Object.keys(json).at(-1)).toBe('truncated')
  return json
}

async function edit(path: string, args: Args): Promise<void> {
  const r = await call('edit_note', { vaultId, path, ...args })
  expect(r.isError, r.text.slice(0, 300)).toBe(false)
}

/** `path#L<n>` of the line of the projected note file that holds `text`, as `git grep -n` finds it. */
async function lineOf(path: string, text: string): Promise<string> {
  await flushProjections()
  const lines = (await readFile(noteFile(vaultId, path), 'utf8')).split('\n')
  const at = lines.findIndex((l) => l.includes(text))
  expect(at, `${text} in ${path}.md`).toBeGreaterThanOrEqual(0)
  expect(lines.filter((l) => l.includes(text)), `${text} once in ${path}.md`).toHaveLength(1)
  return `${path}#L${at + 1}`
}

const rows = (noteId: string) =>
  db
    .select()
    .from(noteLinks)
    .where(eq(noteLinks.sourceNoteId, noteId))
    .orderBy(asc(noteLinks.startLine), asc(noteLinks.targetPath))
    // Every column but the note id (toEqual ignores an undefined key).
    .then((found) => found.map((row) => ({ ...row, sourceNoteId: undefined })))

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'backlinks vault' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'backlinks-agent', scope: 'account' } })
  agent = new Client({ name: 'backlinks-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
}, 60_000)

afterAll(async () => {
  await agent?.close().catch(() => {})
  await app.close()
})

describe('note_links rows carry their context (#472)', () => {
  it('several links to one target on different lines: one row each, with its lines and context; a fenced link is none', async () => {
    const note = await createNote(vaultId, {
      path: 'rows/many',
      body: 'Intro [[rows/t]] here.\n\n```\n[[rows/t]] in a fence\n```\n\nThen [[rows/t]] and [[rows/u]].\nNext line [[rows/t]].\n',
    })
    expect(await rows(note.id)).toEqual([
      { targetPath: 'rows/t', startLine: 1, endLine: 1, context: 'Intro [[rows/t]] here.' },
      { targetPath: 'rows/t', startLine: 7, endLine: 7, context: 'Then [[rows/t]] and [[rows/u]].\nNext line [[rows/t]].' },
      { targetPath: 'rows/u', startLine: 7, endLine: 7, context: 'Then [[rows/t]] and [[rows/u]].\nNext line [[rows/t]].' },
      { targetPath: 'rows/t', startLine: 8, endLine: 8, context: 'Then [[rows/t]] and [[rows/u]].\nNext line [[rows/t]].' },
    ])
  })

  it('a body edit moves the rows; a frontmatter-only edit leaves them as they are', async () => {
    const note = await createNote(vaultId, { path: 'rows/edited', body: 'Top.\n\nSee [[rows/t]] here.\n' })
    await edit('rows/edited', { ops: [{ op: 'prepend', text: 'Intro line.\nSecond intro line.' }] })
    const afterBody = await rows(note.id)
    expect(afterBody).toEqual([{ targetPath: 'rows/t', startLine: 5, endLine: 5, context: 'See [[rows/t]] here.' }])
    await edit('rows/edited', { frontmatter: { summary: 'a frontmatter line', tags: ['one', 'two'] } })
    expect(await rows(note.id)).toEqual(afterBody)
  })
})

describe('graph neighborsOf answers the backlinks of a note (#472)', () => {
  beforeAll(async () => {
    await createNote(vaultId, { path: 'bl/target', body: 'The target note.\n' })
    await createNote(vaultId, {
      path: 'bl/a',
      body: 'Intro paragraph.\n\nFirst mention of [[bl/target]] here.\n\n```\n[[bl/target]] in a fence\n```\n\nSecond [[bl/target|mention]].\n',
      frontmatter: { tags: ['x', 'y'], summary: 'more yaml lines' },
    })
    await createNote(vaultId, { path: 'bl/b', body: 'Only [[bl/target#Heading]] once.\n' })
    // Links elsewhere are no backlinks of the target; nor is a link to itself.
    await createNote(vaultId, { path: 'bl/c', body: 'Points at [[bl/a]].\n' })
    await edit('bl/target', { ops: [{ op: 'append', text: 'Self [[bl/target]].' }] })
  })

  it('lists every link to it, one per line, with the location in the linking file and the context', async () => {
    const json = await graph({ neighborsOf: 'bl/target', budget_tokens: 25_000 })
    expect(json.backlinks).toEqual([
      { path: 'bl/a', location: await lineOf('bl/a', 'First mention of [[bl/target]]'), context: 'First mention of [[bl/target]] here.' },
      { path: 'bl/a', location: await lineOf('bl/a', 'Second [[bl/target|mention]]'), context: 'Second [[bl/target|mention]].' },
      { path: 'bl/b', location: await lineOf('bl/b', 'Only [[bl/target#Heading]]'), context: 'Only [[bl/target#Heading]] once.' },
    ] satisfies Backlink[])
    expect(json.truncated).toBe(false)
    // The backlinks alone: the centre is the only node, so there is no edge.
    const alone = await graph({ neighborsOf: 'bl/target', edgeTypes: ['extracted'], limit: 1, budget_tokens: 25_000 })
    expect(alone).toMatchObject({ nodes: [{ path: 'bl/target' }], edges: [], backlinks: json.backlinks })
  })

  it('locations follow a frontmatter-only edit of the linking note', async () => {
    const before = ((await graph({ neighborsOf: 'bl/target', budget_tokens: 25_000 })).backlinks as Backlink[])[0]!.location
    await edit('bl/a', { frontmatter: { title: 'One more line', tags: ['x', 'y'], summary: 'more yaml lines' } })
    const after = ((await graph({ neighborsOf: 'bl/target', budget_tokens: 25_000 })).backlinks as Backlink[])[0]!.location
    expect(after).toBe(await lineOf('bl/a', 'First mention of [[bl/target]]'))
    expect(Number(/#L(\d+)$/.exec(after)![1])).toBe(Number(/#L(\d+)$/.exec(before)![1]) + 1)
  })

  it('a note nothing links to has an empty list; without extracted edges there is none', async () => {
    expect((await graph({ neighborsOf: 'bl/c' })).backlinks).toEqual([])
    expect((await graph({ neighborsOf: 'bl/target', edgeTypes: ['semantic'] })).backlinks).toBeUndefined()
  })

  it('pages within the budget and counts what it left out', async () => {
    for (let i = 0; i < 40; i++) await createNote(vaultId, { path: `many/n${String(i).padStart(2, '0')}`, body: `Note ${i} links [[bl/popular]] with some words around it.\n` })
    await createNote(vaultId, { path: 'bl/popular', body: 'Popular.\n' })
    const seen: Backlink[] = []
    let cursor: string | null = null
    for (let n = 0; n < 50; n++) {
      const json = await graph({ neighborsOf: 'bl/popular', edgeTypes: ['extracted'], budget_tokens: 600, ...(cursor ? { cursor } : {}) })
      seen.push(...((json.backlinks as Backlink[] | undefined) ?? []))
      if (json.truncated !== false && n === 0) expect(json.truncated.total.backlinks).toBe(40)
      cursor = json.truncated === false ? null : json.truncated.cursor
      if (cursor === null) break
    }
    expect(seen.map((b) => b.path)).toEqual(Array.from({ length: 40 }, (_, i) => `many/n${String(i).padStart(2, '0')}`))
  })
})
