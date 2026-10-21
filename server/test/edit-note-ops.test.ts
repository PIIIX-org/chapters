// #408: an agent's edit_note replaced the whole Y.Text body (delete all,
// insert all), so a person typing in the same note lost their words, and
// an agent could only "append" by sending the whole body back. A whole-body
// edit is now applied to the live document as a minimal character diff in
// one transaction (item 73), and `ops` (append, replace_text, anchors,
// sections, frontmatter) resolve against the live text when they are
// applied (item 72). A missing or ambiguous anchor changes nothing.
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { getLiveNote } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

type Args = Record<string, unknown>

let app: FastifyInstance
let collab: CollabRelay
let baseUrl: string
let ownerToken: string
let cookie: string
let vaultId: string
let mcp: Client
const providers: HocuspocusProvider[] = []

async function call(name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await mcp.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function must<T>(name: string, args: Args): Promise<T> {
  const r = await call(name, args)
  if (r.isError) throw new Error(`${name} failed: ${r.text}`)
  return JSON.parse(r.text) as T
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

/** A browser tab on the note, through the real relay. */
function open(path: string): HocuspocusProvider {
  const provider = new HocuspocusProvider({
    url: `${baseUrl.replace('http', 'ws')}/collab`,
    name: `${vaultId}/${path}`,
    token: ownerToken,
    document: new Y.Doc(),
  })
  providers.push(provider)
  return provider
}

/** The relay's live body of the note, or undefined when it is not loaded. */
function liveBody(path: string): string | undefined {
  return collab.hocuspocus.documents.get(`${vaultId}/${path}`)?.getText('body').toString()
}

async function rowBody(path: string): Promise<string | undefined> {
  return (await getLiveNote(vaultId, path))?.body
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  ownerToken = await loginToken(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Edit ops' } })).json<{ id: string }>().id
  const minted = await app.inject({
    method: 'POST',
    url: '/api/mcp-connections',
    headers: { cookie },
    body: { name: 'edit-ops', scope: 'account' },
  })
  mcp = new Client({ name: 'edit-ops-test', version: '0.0.0' })
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

describe('edit_note with a person typing in the note (#408)', () => {
  it('a whole-body edit keeps typing that reaches the relay after it, where it was typed', async () => {
    const path = 'docs/live-whole-body'
    const body = 'Para one.\n\nPara two.\n'
    await must('create_note', { vaultId, path, body })
    // A second tab keeps the document loaded while the first is offline.
    const other = open(path)
    const tab = open(path)
    const text = tab.document.getText('body')
    await waitFor(() => text.toString() === body && other.document.getText('body').toString() === body)

    // The person types while their update is still on its way to the relay.
    tab.disconnect()
    text.insert(body.indexOf('two'), 'TYPED ')
    const r = await call('edit_note', { vaultId, path, body: `${body}Agent line.\n` })
    expect(r.isError, r.text).toBe(false)
    await tab.connect()

    const expected = 'Para one.\n\nPara TYPED two.\nAgent line.\n'
    await waitFor(() => text.toString().includes('Agent line.') && (liveBody(path) ?? '').includes('TYPED'))
    expect(text.toString()).toBe(expected)
    expect(liveBody(path)).toBe(expected)
    await waitFor(() => other.document.getText('body').toString() === expected)
    await waitFor(async () => (await rowBody(path)) === expected)
  }, 20_000)

  it('an append op while a person types elsewhere keeps every typed word, in order', async () => {
    const path = 'docs/live-append'
    const body = 'Para one.\n\nPara two.\n'
    await must('create_note', { vaultId, path, body })
    const tab = open(path)
    const text = tab.document.getText('body')
    await waitFor(() => text.toString() === body)

    // Typing at the second paragraph, a word every 10 ms, before the relay
    // stores anything (its debounce is 2 s): the file still has the old body.
    let typed = ''
    const at = body.indexOf('two')
    const typing = (async () => {
      for (let i = 0; i < 30; i++) {
        const word = `w${i} `
        text.insert(at + typed.length, word)
        typed += word
        await sleep(10)
      }
    })()
    await waitFor(() => typed.length > 20)
    const r = await call('edit_note', { vaultId, path, ops: [{ op: 'append', text: 'Agent line.' }] })
    expect(r.isError, r.text).toBe(false)
    await typing

    const expected = `Para one.\n\nPara ${typed}two.\nAgent line.\n`
    await waitFor(() => liveBody(path) === expected && text.toString() === expected)
    await waitFor(async () => (await rowBody(path)) === expected)
  }, 20_000)
})

describe('edit_note ops (#408)', () => {
  const base = '# Title\n\nIntro with foo.\n\n## Plan\n\nOld plan.\n\n### Detail\n\nDetail text.\n\n## Log\n\n- one\n'
  let n = 0
  /** A fresh note with `base`, open in a tab so ops run against the live document. */
  async function fresh(body = base, frontmatter?: Args): Promise<string> {
    const path = `docs/ops-${++n}`
    await must('create_note', { vaultId, path, body, ...(frontmatter ? { frontmatter } : {}) })
    const tab = open(path)
    await waitFor(() => tab.document.getText('body').toString() === body)
    return path
  }

  const cases: Array<[string, Args[], string]> = [
    ['append', [{ op: 'append', text: '- two' }], `${base}- two\n`],
    ['prepend', [{ op: 'prepend', text: 'Lead line.' }], `Lead line.\n${base}`],
    ['replace_text', [{ op: 'replace_text', find: 'Old plan.', replace: 'New plan.' }], base.replace('Old plan.', 'New plan.')],
    ['insert_before', [{ op: 'insert_before', anchor: '## Log', text: 'Before log.\n\n' }], base.replace('## Log', 'Before log.\n\n## Log')],
    ['insert_after', [{ op: 'insert_after', anchor: 'Intro with foo.', text: ' More.' }], base.replace('Intro with foo.', 'Intro with foo. More.')],
    [
      'replace_section',
      [{ op: 'replace_section', heading: '## Plan', content: 'Fresh plan.' }],
      '# Title\n\nIntro with foo.\n\n## Plan\n\nFresh plan.\n\n## Log\n\n- one\n',
    ],
    ['replace_section by heading text', [{ op: 'replace_section', heading: 'Detail', content: 'New detail.\n' }], base.replace('Detail text.', 'New detail.')],
    ['delete_block', [{ op: 'delete_block', find: '### Detail\n\nDetail text.\n\n' }], base.replace('### Detail\n\nDetail text.\n\n', '')],
    [
      'several ops in order',
      [
        { op: 'replace_text', find: 'foo', replace: 'bar' },
        { op: 'append', text: '- two' },
        { op: 'insert_after', anchor: 'bar', text: '!' },
      ],
      `${base.replace('foo', 'bar!')}- two\n`,
    ],
  ]
  for (const [name, ops, expected] of cases) {
    it(name, async () => {
      const path = await fresh()
      const r = await call('edit_note', { vaultId, path, ops })
      expect(r.isError, r.text).toBe(false)
      expect(JSON.parse(r.text)).toMatchObject({ body: expected })
      expect(liveBody(path)).toBe(expected)
      expect(await rowBody(path)).toBe(expected)
    })
  }

  it('replace_text with expectedCount replaces every occurrence', async () => {
    const path = await fresh('a x b x c\n')
    const r = await call('edit_note', { vaultId, path, ops: [{ op: 'replace_text', find: 'x', replace: 'y', expectedCount: 2 }] })
    expect(r.isError, r.text).toBe(false)
    expect(await rowBody(path)).toBe('a y b y c\n')
  })

  it('frontmatter set, add and remove merge onto the live frontmatter', async () => {
    const path = await fresh(base, { type: 'docs', title: 'T', tags: ['a'], status: 'draft' })
    const r = await call('edit_note', {
      vaultId,
      path,
      ops: [
        { op: 'frontmatter_set', key: 'title', value: 'New title' },
        { op: 'frontmatter_add', key: 'tags', value: 'b' },
        { op: 'frontmatter_add', key: 'tags', value: 'a' },
        { op: 'frontmatter_add', key: 'aliases', value: 'alt' },
        { op: 'frontmatter_remove', key: 'status' },
      ],
    })
    expect(r.isError, r.text).toBe(false)
    const note = await must<{ frontmatter: Args; body: string }>('read_note', { vaultId, path })
    expect(note.frontmatter).toMatchObject({ type: 'docs', title: 'New title', tags: ['a', 'b'], aliases: ['alt'] })
    expect(note.frontmatter).not.toHaveProperty('status')
    expect(note.body).toBe(base)

    const removed = await call('edit_note', { vaultId, path, ops: [{ op: 'frontmatter_remove', key: 'tags', value: 'a' }] })
    expect(removed.isError, removed.text).toBe(false)
    expect((await must<{ frontmatter: Args }>('read_note', { vaultId, path })).frontmatter.tags).toEqual(['b'])
  })

  it('refuses an ambiguous or missing anchor and changes nothing, not even earlier ops', async () => {
    const body = 'foo one\nfoo two\n'
    const path = await fresh(body)
    const ambiguous = await call('edit_note', {
      vaultId,
      path,
      ops: [
        { op: 'append', text: 'appended' },
        { op: 'insert_after', anchor: 'foo', text: '!' },
      ],
    })
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toMatch(/ops\[1\].*"foo".*2 times/)
    const missing = await call('edit_note', { vaultId, path, ops: [{ op: 'delete_block', find: 'nowhere' }] })
    expect(missing.isError).toBe(true)
    expect(missing.text).toMatch(/ops\[0\].*"nowhere".*not found/)
    // The index counts frontmatter ops too.
    const afterFrontmatter = await call('edit_note', {
      vaultId,
      path,
      ops: [
        { op: 'frontmatter_set', key: 'status', value: 'x' },
        { op: 'replace_text', find: 'nowhere', replace: 'y' },
      ],
    })
    expect(afterFrontmatter.isError).toBe(true)
    expect(afterFrontmatter.text).toMatch(/ops\[1\] replace_text: "nowhere" not found/)
    const count = await call('edit_note', { vaultId, path, ops: [{ op: 'replace_text', find: 'foo', replace: 'bar' }] })
    expect(count.isError).toBe(true)
    expect(count.text).toMatch(/2 times.*expectedCount/)
    const section = await call('edit_note', { vaultId, path, ops: [{ op: 'replace_section', heading: 'Nope', content: 'x' }] })
    expect(section.isError).toBe(true)
    expect(liveBody(path)).toBe(body)
    expect(await rowBody(path)).toBe(body)
  })

  it('refuses ops together with body, and unknown keys inside an op', async () => {
    const path = await fresh()
    const both = await call('edit_note', { vaultId, path, body: 'x', ops: [{ op: 'append', text: 'y' }] })
    expect(both.isError).toBe(true)
    expect(both.text).toMatch(/`ops`.*`body`/)
    const unknown = await call('edit_note', { vaultId, path, ops: [{ op: 'append', text: 'y', where: 'end' }] })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('"where"')
    expect(await rowBody(path)).toBe(base)
  })

  it('REST PUT refuses `ops` with 400 and changes nothing (they are edit_note arguments)', async () => {
    const path = await fresh()
    const put = (body: object) => app.inject({ method: 'PUT', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie }, body })
    for (const ops of [[{ op: 'insert_after', anchor: 'foo', text: 'x' }], [{ op: 'append' }], []]) {
      const refused = await put({ ops })
      expect(refused.statusCode, refused.body).toBe(400)
      expect(refused.json<{ error: string }>().error).toMatch(/`ops` is an edit_note \(MCP\) argument/)
    }
    expect(liveBody(path)).toBe(base)
    expect(await rowBody(path)).toBe(base)
    const ok = await put({ body: `${base}more\n` })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await rowBody(path)).toBe(`${base}more\n`)
  })

  it('with base_rev, ops still apply to the live text, and the result says what changed since (#475)', async () => {
    const path = await fresh()
    const { rev } = await must<{ rev: number }>('read_note', { vaultId, path })
    const applied = await must<Args>('edit_note', { vaultId, path, base_rev: rev, ops: [{ op: 'append', text: 'ok' }] })
    expect(applied).toMatchObject({ baseRev: rev, status: 'applied', body: `${base}ok\n`, concurrent_changes: null })
    const merged = await must<Args>('edit_note', { vaultId, path, base_rev: rev, ops: [{ op: 'append', text: 'again' }] })
    expect(merged).toMatchObject({
      baseRev: rev,
      status: 'merged',
      body: `${base}ok\nagain\n`,
      concurrent_changes: { lines: [{ line: 16, removed: 0, added: 1 }] },
    })
  })

  it('checks the size cap and the growth quarantine on the body the ops produce', async () => {
    const near = `${'x'.repeat(config.noteMaxBytes - 10)}\n`
    const big = await fresh(near)
    const over = await call('edit_note', { vaultId, path: big, ops: [{ op: 'append', text: 'y'.repeat(100) }] })
    expect(over.isError).toBe(true)
    expect(over.text).toMatch(/limit is/)
    expect(liveBody(big)).toBe(near)

    const block = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} says something distinct about item ${i * 17}.`).join('\n\n')
    const path = await fresh(`${block}\n`)
    const doubled = await call('edit_note', { vaultId, path, ops: [{ op: 'append', text: block }] })
    expect(doubled.isError).toBe(true)
    expect(doubled.text).toMatch(/quarantine/i)
    expect(liveBody(path)).toBe(`${block}\n`)
    expect(await rowBody(path)).toBe(`${block}\n`)
  }, 20_000)
})
