// #475: after #408 a whole `body` from edit_note is a minimal diff from the
// note's live text, so an agent that read the note and sent its whole body
// back still removed every word a person typed since the read; `base_rev`
// was only echoed. read_note now returns `rev`, and an edit made from that
// revision is three-way merged: the agent's changed lines are applied to the
// live document when no change since the base touches them (`merged`, with
// the concurrent changes listed); when they overlap, the live text is left
// alone and the agent's version is kept as a `proposal` revision linked to
// its base (`conflicted`).
//
// #408, #476: an edit_note `body` sent without `base_rev` is merged the same
// way against the `rev` of the connection's last read_note of the note, so
// an agent that reads, appends a line and sends the whole body back keeps
// what a person typed after the read (the lab's browser S1). With no read on
// record it is a diff from the live text, as before. Every whole-markdown
// write (edit_note `body`, REST PUT, revert) reaches the live document as a
// diff from its text, never as delete-all and insert-all.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import { getBaseRevision, getLiveNote, updateNote } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken, noteDocName, toolText } from './helpers.js'

type Args = Record<string, unknown>

interface Read {
  body: string
  rev?: number
}

interface HistoryRow {
  id: string
  action: string
  actorType: string
  actorName?: string | null
  sourceRevisionId?: string
}

let app: FastifyInstance
let collab: CollabRelay
let baseUrl: string
let ownerToken: string
let cookie: string
let vaultId: string
let mcp: Client
const clients: Client[] = []
const providers: HocuspocusProvider[] = []

async function connect(name: string): Promise<Client> {
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name, scope: 'account' } })
  const client = new Client({ name: `${name}-test`, version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  clients.push(client)
  return client
}

async function call(name: string, args: Args, client = mcp): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: toolText(content) }
}

async function must<T>(name: string, args: Args, client = mcp): Promise<T> {
  const r = await call(name, args, client)
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

/** The document name each opened path's note has (by note id, ADR-003 §5.4). */
const docNames = new Map<string, string>()

/** A browser tab on the note, through the real relay. */
async function open(path: string): Promise<HocuspocusProvider> {
  const name = await noteDocName(vaultId, path)
  docNames.set(path, name)
  const provider = new HocuspocusProvider({
    url: `${baseUrl.replace('http', 'ws')}/collab`,
    name,
    token: ownerToken,
    document: new Y.Doc(),
  })
  providers.push(provider)
  return provider
}

/** The relay's live body of the note, or undefined when it is not loaded. */
function liveBody(path: string): string | undefined {
  return collab.hocuspocus.documents.get(docNames.get(path) ?? '')?.getText('body').toString()
}

async function rowBody(path: string): Promise<string | undefined> {
  return (await getLiveNote(vaultId, path))?.body
}

async function history(path: string): Promise<HistoryRow[]> {
  return (await must<{ revisions: HistoryRow[] }>('note_history', { vaultId, path })).revisions
}

const BODY = 'Para one.\n\nPara two.\n\nPara three.\n'

/** 80 distinct lines of 75 bytes: 6000 bytes, so the growth rule's 2 KiB floor holds after a cut to 30 lines too. */
const LINES = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(2, '0')} holds its own words about item ${i * 7 + 3}, nothing repeated.`.padEnd(74, '.') + '\n')

/** A note with BODY, open in a tab; the tab's text is the person's editor. */
async function noteInTab(path: string, frontmatter?: Args): Promise<Y.Text> {
  await must('create_note', { vaultId, path, body: BODY, ...(frontmatter ? { frontmatter } : {}) })
  const text = (await open(path)).document.getText('body')
  await waitFor(() => text.toString() === BODY && liveBody(path) === BODY)
  return text
}

/** The person types `word` before `before`, and the relay has it. */
async function type(path: string, text: Y.Text, before: string, word: string): Promise<string> {
  text.insert(text.toString().indexOf(before), word)
  const typed = text.toString()
  await waitFor(() => liveBody(path) === typed)
  return typed
}

/** The person types `chars` at the end of the note (no newline: a line being typed), and the relay has it. */
async function typeAtEnd(path: string, text: Y.Text, chars: string): Promise<string> {
  text.insert(text.length, chars)
  const typed = text.toString()
  await waitFor(() => liveBody(path) === typed)
  return typed
}

/** The lab's agent append: the body read_note returned, ended with a newline, plus one line. */
const appended = (read: string, line: string) => `${read.endsWith('\n') || read === '' ? read : `${read}\n`}${line}\n`

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
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Base rev' } })).json<{ id: string }>().id
  mcp = await connect('edit-base')
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  for (const client of clients) await client.close()
  await collab.destroy()
  await app.close()
})

describe('edit_note with a stale base_rev (#475)', () => {
  it("read_note returns rev, the note's seq (#477); the revision at it is the note's newest", async () => {
    const path = 'docs/rev-read'
    await must('create_note', { vaultId, path, body: BODY })
    const read = await must<Read>('read_note', { vaultId, path })
    expect(read.rev).toBe(1)
    await must('edit_note', { vaultId, path, body: `${BODY}More.\n` })
    expect((await must<Read>('read_note', { vaultId, path })).rev).toBe(2)
  })

  it("merges an agent's whole body made from an older revision: a person's typing in another paragraph is kept", async () => {
    const path = 'docs/rev-merge'
    const text = await noteInTab(path)
    const read = await must<Read>('read_note', { vaultId, path })
    expect(read.rev).toBeTruthy()

    // The person types in the first paragraph after the agent read the note.
    await type(path, text, 'one.', 'TYPED ')
    const r = await call('edit_note', { vaultId, path, base_rev: read.rev, body: read.body.replace('Para three.', 'Para three, revised.') })
    expect(r.isError, r.text).toBe(false)

    const expected = 'Para TYPED one.\n\nPara two.\n\nPara three, revised.\n'
    const result = JSON.parse(r.text) as Record<string, unknown>
    expect(result).toMatchObject({
      status: 'merged',
      baseRev: read.rev,
      body: expected,
      concurrent_changes: { lines: [{ line: 1, removed: 1, added: 1 }] },
    })
    expect(typeof result.rev).toBe('number')
    await waitFor(() => text.toString() === expected && liveBody(path) === expected)
    await waitFor(async () => (await rowBody(path)) === expected)
  })

  it("leaves the person's text untouched when the agent's change overlaps it, and keeps the agent's version as a proposal", async () => {
    const path = 'docs/rev-conflict'
    const text = await noteInTab(path)
    const read = await must<Read>('read_note', { vaultId, path })
    expect(read.rev).toBeTruthy()

    const typed = await type(path, text, 'two.', 'TYPED ')
    const agentBody = read.body.replace('Para two.', 'Para 2, rewritten by the agent.')
    const r = await call('edit_note', { vaultId, path, base_rev: read.rev, body: agentBody })
    expect(r.isError, r.text).toBe(false)
    const result = JSON.parse(r.text) as { status: string; proposalId: string; baseRev: string; conflicts: unknown }
    expect(result).toMatchObject({ status: 'conflicted', baseRev: read.rev, conflicts: { lines: [{ line: 3, removed: 1, added: 1 }] } })
    expect(result.proposalId).toMatch(/^[0-9a-f-]{36}$/)

    // Nothing reached the person's editor, the relay or the stored note.
    await sleep(300)
    expect(text.toString()).toBe(typed)
    expect(liveBody(path)).toBe(typed)
    expect(await rowBody(path)).not.toContain('rewritten by the agent')

    // The agent's version is a revision linked to the base it was made from (#479's source_revision_id): the revision at rev.
    const baseId = (await getBaseRevision(vaultId, path, read.rev!))!.id
    const proposal = await must<{ action: string; body: string; sourceRevisionId: string }>('get_revision', { vaultId, path, revisionId: result.proposalId })
    expect(proposal).toMatchObject({ action: 'proposal', body: agentBody, sourceRevisionId: baseId })
    const listed = (await history(path)).find((row) => row.id === result.proposalId)
    expect(listed).toMatchObject({ action: 'proposal', actorType: 'mcp', actorName: 'edit-base', sourceRevisionId: baseId })

    // The same edit sent again keeps one proposal.
    const again = JSON.parse((await call('edit_note', { vaultId, path, base_rev: read.rev, body: agentBody })).text) as { proposalId: string }
    expect(again.proposalId).toBe(result.proposalId)
    expect((await history(path)).filter((row) => row.action === 'proposal')).toHaveLength(1)
  })

  it('merges the frontmatter per key: a key the agent did not change keeps the live value; one both changed conflicts', async () => {
    const path = 'docs/rev-frontmatter'
    await must('create_note', { vaultId, path, body: BODY, frontmatter: { title: 'Start', status: 'draft' } })
    const read = await must<Read>('read_note', { vaultId, path })
    // A person renames the note meanwhile.
    const put = await app.inject({ method: 'PUT', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie }, body: { frontmatter: { title: 'Renamed by a person' } } })
    expect(put.statusCode, put.body).toBe(200)

    const clean = await call('edit_note', { vaultId, path, base_rev: read.rev, frontmatter: { title: 'Start', status: 'active' } })
    expect(clean.isError, clean.text).toBe(false)
    expect(JSON.parse(clean.text)).toMatchObject({
      status: 'merged',
      frontmatter: { title: 'Renamed by a person', status: 'active' },
      concurrent_changes: { frontmatterKeys: ['title'] },
    })

    const clash = await call('edit_note', { vaultId, path, base_rev: read.rev, frontmatter: { title: 'Agent title' } })
    expect(clash.isError, clash.text).toBe(false)
    expect(JSON.parse(clash.text)).toMatchObject({ status: 'conflicted', conflicts: { frontmatterKeys: ['title'] } })
    expect((await getLiveNote(vaultId, path))?.frontmatter).toMatchObject({ title: 'Renamed by a person', status: 'active' })
  })

  it("a based edit is not quarantined because a person shortened the note since the agent's read", async () => {
    const path = 'docs/rev-shortened'
    await must('create_note', { vaultId, path, body: LINES.join('') })
    const read = await must<Read>('read_note', { vaultId, path })
    // A person deletes the last 50 lines: 2250 bytes are left.
    const kept = LINES.slice(0, 30).join('')
    const cut = await app.inject({ method: 'PUT', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie }, body: { body: kept } })
    expect(cut.statusCode, cut.body).toBe(200)

    const edited = await call('edit_note', { vaultId, path, base_rev: read.rev, body: read.body.replace('Line 00', 'Line 00, edited,') })
    expect(edited.isError, edited.text).toBe(false)
    expect(JSON.parse(edited.text)).toMatchObject({ status: 'merged', body: kept.replace('Line 00', 'Line 00, edited,') })
    expect((await history(path)).map((row) => row.action)).not.toContain('quarantine')
  })

  describe('when the note file is damaged, so no live document loads (#384, #391)', () => {
    // A full edit (frontmatter and body) is then written to the stored row directly; with a base it is still rebased and screened.
    const damage = (path: string) => writeFile(join(config.dataDir, 'vaults', vaultId, `${path}.md`), '## Concepts & Artifacts\n\n| Concept |\n', 'utf8')

    it('a based edit that doubles the note is quarantined, as without base_rev', async () => {
      const path = 'docs/rev-damaged-doubled'
      await must('create_note', { vaultId, path, body: LINES.join('') })
      const read = await must<Read>('read_note', { vaultId, path })
      await damage(path)
      const doubled = await call('edit_note', { vaultId, path, base_rev: read.rev, frontmatter: {}, body: read.body + read.body })
      expect(doubled.isError, doubled.text).toBe(true)
      expect(doubled.text).toMatch(/quarantine/i)
      expect(await rowBody(path)).toBe(read.body)
    })

    it('a based edit keeps the lines a person deleted since the read', async () => {
      const path = 'docs/rev-damaged-shortened'
      await must('create_note', { vaultId, path, body: LINES.join('') })
      const read = await must<Read>('read_note', { vaultId, path })
      const kept = LINES.slice(0, 10).join('')
      expect(await updateNote(vaultId, path, { body: kept }, { type: 'user' })).toBeTruthy()
      await damage(path)
      const edited = await call('edit_note', { vaultId, path, base_rev: read.rev, frontmatter: {}, body: read.body.replace('Line 00', 'Line 00, edited,') })
      expect(edited.isError, edited.text).toBe(false)
      const expected = kept.replace('Line 00', 'Line 00, edited,')
      expect(JSON.parse(edited.text)).toMatchObject({ status: 'merged', body: expected })
      expect(await rowBody(path)).toBe(expected)
    })
  })

  it('a conflicting edit with ops keeps them in the proposal: body ops on the live text, frontmatter ops on its map', async () => {
    const path = 'docs/rev-ops-proposal'
    await must('create_note', { vaultId, path, body: BODY, frontmatter: { title: 'Start' } })
    const read = await must<Read>('read_note', { vaultId, path })
    const put = await app.inject({ method: 'PUT', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie }, body: { frontmatter: { title: 'Renamed by a person' } } })
    expect(put.statusCode, put.body).toBe(200)

    const r = await must<{ status: string; proposalId: string }>('edit_note', {
      vaultId,
      path,
      base_rev: read.rev,
      frontmatter: { title: 'Agent title' },
      ops: [
        { op: 'append', text: 'Agent line.' },
        { op: 'frontmatter_add', key: 'tags', value: 'agent' },
      ],
    })
    expect(r.status).toBe('conflicted')
    const proposal = await must<{ frontmatter: Args; body: string }>('get_revision', { vaultId, path, revisionId: r.proposalId })
    expect(proposal.body).toBe(`${BODY}Agent line.\n`)
    expect(proposal.frontmatter).toMatchObject({ title: 'Agent title', tags: ['agent'] })
    expect(await rowBody(path)).toBe(BODY)
  })

  it('reports applied when nothing changed since the base, and its rev is the next base', async () => {
    const path = 'docs/rev-chain'
    const text = await noteInTab(path)
    const read = await must<Read>('read_note', { vaultId, path })
    const first = await must<{ status: string; rev: string; body: string }>('edit_note', {
      vaultId,
      path,
      base_rev: read.rev,
      body: read.body.replace('Para one.', 'Para one, first.'),
    })
    expect(first.status).toBe('applied')
    expect(first.rev).not.toBe(read.rev)

    const typed = await type(path, text, 'three.', 'TYPED ')
    const second = await must<{ status: string; body: string }>('edit_note', {
      vaultId,
      path,
      base_rev: first.rev,
      body: first.body.replace('Para two.', 'Para two, second.'),
    })
    expect(second.status).toBe('merged')
    expect(second.body).toBe(typed.replace('Para two.', 'Para two, second.'))
  })

  it('refuses a base_rev that is not a revision of the note, and changes nothing', async () => {
    const path = 'docs/rev-unknown'
    await noteInTab(path)
    const other = 'docs/rev-other'
    await must('create_note', { vaultId, path: other, body: 'Other.\n' })
    const otherRevision = (await must<{ revisions: Array<{ id: string }> }>('note_history', { vaultId, path: other })).revisions[0]!.id
    const bad = ['stale-or-not', '00000000-0000-4000-8000-000000000000', otherRevision, 999]
    for (const baseRev of bad) {
      const r = await call('edit_note', { vaultId, path, base_rev: baseRev, body: 'Replaced.\n' })
      expect(r.isError, `${String(baseRev)}: ${r.text}`).toBe(true)
      expect(r.text).toMatch(/base_rev/)
    }
    expect(liveBody(path)).toBe(BODY)
    expect(await rowBody(path)).toBe(BODY)
  })

  it('without base_rev, from a connection that never read the note, a whole body still replaces the live text as a minimal diff', async () => {
    const path = 'docs/rev-none'
    const text = await noteInTab(path)
    const agent = await connect('edit-base-unread')
    await type(path, text, 'one.', 'TYPED ')
    const body = BODY.replace('Para three.', 'Para three, revised.')
    const r = await call('edit_note', { vaultId, path, body }, agent)
    expect(r.isError, r.text).toBe(false)
    const result = JSON.parse(r.text) as Record<string, unknown>
    expect(result.body).toBe(body)
    expect(result).toMatchObject({ status: 'applied', concurrent_changes: null })
    expect(result).not.toHaveProperty('baseRev')
    await waitFor(() => text.toString() === body)
  })

  it('a proposal is not a state of the note: neither the dedupe baseline nor the start of a session', async () => {
    const path = 'docs/rev-baseline'
    await noteInTab(path)
    const agent = await connect('edit-base-fresh')
    const read = await must<Read>('read_note', { vaultId, path }, agent)
    // Rows by the relay (`collab`) come and go with its debounce; the authored ones are what this checks.
    const authored = async (): Promise<string[]> =>
      (await history(path)).filter((row) => row.actorType !== 'collab').map((row) => `${row.actorType} ${row.action}`)
    const personBody = BODY.replace('Para two.', 'Para two, by a person.')
    const saved = await app.inject({ method: 'PUT', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie }, body: { body: personBody } })
    expect(saved.statusCode, saved.body).toBe(200)
    const conflicted = await must<{ status: string }>('edit_note', { vaultId, path, base_rev: read.rev, body: read.body.replace('Para two.', 'Para 2.') }, agent)
    expect(conflicted.status).toBe('conflicted')
    expect(await authored()).toEqual(['mcp proposal', 'user update', 'mcp create'])

    // The person saving the same text again repeats their own latest state: the proposal is never the baseline.
    const again = await app.inject({ method: 'PUT', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie }, body: { body: personBody } })
    expect(again.statusCode, again.body).toBe(200)
    expect(await authored()).toEqual(['mcp proposal', 'user update', 'mcp create'])

    // The connection's first write that lands keeps a restore point: the proposal did not start its session.
    await must('edit_note', { vaultId, path, ops: [{ op: 'append', text: 'Agent line.' }] }, agent)
    expect(await authored()).toEqual(['mcp update', 'mcp restore_point', 'mcp proposal', 'user update', 'mcp create'])
  })
})

describe("a whole body without base_rev merges against the connection's last read (#408, #476)", () => {
  it('keeps every character a person typed at the end after the read; the agent line goes after them (lab browser S1)', async () => {
    const path = 'docs/last-read-s1'
    const text = await noteInTab(path)
    await typeAtEnd(path, text, ' a01 a0')
    const read = await must<Read>('read_note', { vaultId, path })
    expect(read.body).toBe(`${BODY} a01 a0`)

    // The person goes on typing the same token after the agent's read.
    const typed = await typeAtEnd(path, text, '2 a03 a')
    const r = await must<Record<string, unknown>>('edit_note', { vaultId, path, body: appended(read.body, 'AGENT-S1') })
    const expected = `${typed}\nAGENT-S1\n`
    expect(r).toMatchObject({ status: 'merged', baseRev: read.rev, body: expected, concurrent_changes: { lines: [{ line: 6, removed: 1, added: 1 }] } })
    await waitFor(() => text.toString() === expected && liveBody(path) === expected)
    await waitFor(async () => (await rowBody(path)) === expected)

    // The person types on their line (before the agent's), the agent appends again from a new read: the typing stays contiguous.
    text.insert(typed.length, '04 a05')
    await waitFor(() => liveBody(path) === text.toString())
    const again = await must<Read>('read_note', { vaultId, path })
    text.insert(text.toString().indexOf('\nAGENT-S1'), ' a06 a')
    await waitFor(() => liveBody(path) === text.toString())
    const second = await must<Record<string, unknown>>('edit_note', { vaultId, path, body: appended(again.body, 'AGENT-S1B') })
    const final = `${BODY} a01 a02 a03 a04 a05 a06 a\nAGENT-S1\nAGENT-S1B\n`
    expect(second).toMatchObject({ status: 'merged', baseRev: again.rev, body: final })
    await waitFor(() => text.toString() === final && liveBody(path) === final)
  }, 20_000)

  it('puts the agent line after a new last line the person started typing after the read', async () => {
    const path = 'docs/last-read-new-line'
    const text = await noteInTab(path)
    const read = await must<Read>('read_note', { vaultId, path })
    const typed = await typeAtEnd(path, text, ' b01 b0')
    const r = await must<Record<string, unknown>>('edit_note', { vaultId, path, body: appended(read.body, 'AGENT-LINE') })
    expect(r).toMatchObject({ status: 'merged', baseRev: read.rev, body: `${typed}\nAGENT-LINE\n` })
    await waitFor(() => text.toString() === `${typed}\nAGENT-LINE\n`)
  }, 20_000)

  it('two appends from one read, the person typing between them: nothing typed is lost and no agent line doubles', async () => {
    const path = 'docs/last-read-twice'
    const text = await noteInTab(path)
    await typeAtEnd(path, text, ' c01')
    const read = await must<Read>('read_note', { vaultId, path })
    await typeAtEnd(path, text, ' c02')
    const first = await must<{ status: string; body: string; rev: number }>('edit_note', { vaultId, path, body: appended(read.body, 'AGENT-ONE') })
    expect(first.status).toBe('merged')
    text.insert(text.toString().indexOf('\nAGENT-ONE'), ' c03')
    await waitFor(() => liveBody(path) === text.toString())
    // The agent builds on the body it sent, without reading again: that body, at the first write's rev, is its base.
    const second = await must<{ status: string; body: string }>('edit_note', { vaultId, path, body: appended(appended(read.body, 'AGENT-ONE'), 'AGENT-TWO') })
    const expected = `${BODY} c01 c02 c03\nAGENT-ONE\nAGENT-TWO\n`
    expect(second).toMatchObject({ status: 'merged', baseRev: first.rev, body: expected })
    await waitFor(() => text.toString() === expected)
  }, 20_000)

  it("two appends from one read while another agent appends between them: the first agent's line is not written twice (#864 review)", async () => {
    const path = 'docs/last-read-two-agents'
    await must('create_note', { vaultId, path, body: BODY })
    const other = await connect('edit-base-other')
    const read = await must<Read>('read_note', { vaultId, path })
    await must('append_note', { vaultId, path, text: 'B1' }, other)
    const first = await must<{ status: string; body: string; rev: number }>('edit_note', { vaultId, path, body: appended(read.body, 'A1') })
    expect(first).toMatchObject({ status: 'merged', body: `${BODY}B1\nA1\n` })
    await must('append_note', { vaultId, path, text: 'B2' }, other)
    const second = await must<{ status: string; body: string }>('edit_note', { vaultId, path, body: appended(appended(read.body, 'A1'), 'A2') })
    expect(second).toMatchObject({ status: 'merged', baseRev: first.rev, body: `${BODY}B1\nA1\nB2\nA2\n` })
  }, 20_000)

  it("a whole body that was applied as sent is the agent's next base: a later edit from it keeps typing done since", async () => {
    const path = 'docs/last-read-chain'
    const text = await noteInTab(path)
    const read = await must<Read>('read_note', { vaultId, path })
    const mine = read.body.replace('Para one.', 'Para one, first.')
    const first = await must<{ status: string; rev: number; body: string }>('edit_note', { vaultId, path, body: mine })
    expect(first).toMatchObject({ status: 'applied', baseRev: read.rev, body: mine })

    const typed = await type(path, text, 'three.', 'TYPED ')
    const second = await must<{ status: string; body: string }>('edit_note', { vaultId, path, body: mine.replace('Para two.', 'Para two, second.') })
    expect(second).toMatchObject({ status: 'merged', baseRev: first.rev, body: typed.replace('Para two.', 'Para two, second.') })
  }, 20_000)

  it("an agent body that rewrites the line the person typed in is not applied: the typing stays, the agent's version is a proposal", async () => {
    const path = 'docs/last-read-conflict'
    const text = await noteInTab(path)
    const read = await must<Read>('read_note', { vaultId, path })
    const typed = await type(path, text, 'two.', 'TYPED ')
    const agentBody = read.body.replace('Para two.', 'Para 2, by the agent.')
    const r = await must<{ status: string; baseRev: number; proposalId: string; message: string }>('edit_note', { vaultId, path, body: agentBody })
    expect(r).toMatchObject({ status: 'conflicted', baseRev: read.rev, conflicts: { lines: [{ line: 3, removed: 1, added: 1 }] } })
    expect(r.message).toMatch(/last read/)
    await sleep(300)
    expect(text.toString()).toBe(typed)
    expect(await rowBody(path)).toBe(typed)
    const proposal = await must<{ action: string; body: string }>('get_revision', { vaultId, path, revisionId: r.proposalId })
    expect(proposal).toMatchObject({ action: 'proposal', body: agentBody })
  }, 20_000)
})

describe('upsert_note and REST PUT merge a whole body from its base too (#865)', () => {
  /** The person's REST PUT of `body` to `path`, with `baseRev` when given. */
  const put = (path: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie }, body })

  it("upsert_note of an existing note merges from the connection's last read: typing done after the read stays (S1 shape)", async () => {
    const path = 'docs/upsert-s1'
    const text = await noteInTab(path)
    await typeAtEnd(path, text, ' u01 u0')
    const read = await must<Read>('read_note', { vaultId, path })
    const typed = await typeAtEnd(path, text, '2 u03 u')
    const r = await must<Record<string, unknown>>('upsert_note', { vaultId, path, body: appended(read.body, 'AGENT-UPSERT') })
    const expected = `${typed}\nAGENT-UPSERT\n`
    expect(r).toMatchObject({ created: false, status: 'merged', baseRev: read.rev, body: expected })
    await waitFor(() => text.toString() === expected && liveBody(path) === expected)
  }, 20_000)

  it('a note upsert_note created is its base: the next whole-body upsert keeps typing done since, without a read (#879 review)', async () => {
    const path = 'docs/upsert-created'
    const agent = await connect('edit-base-upsert-create')
    const made = await must<{ created: boolean; rev: number; body: string }>('upsert_note', { vaultId, path, body: BODY }, agent)
    expect(made.created).toBe(true)
    const text = (await open(path)).document.getText('body')
    await waitFor(() => text.toString() === BODY && liveBody(path) === BODY)
    const typed = await typeAtEnd(path, text, ' v01 v0')
    const r = await must<Record<string, unknown>>('upsert_note', { vaultId, path, body: `${BODY}AGENT-AFTER-CREATE\n` }, agent)
    expect(r).toMatchObject({ created: false, status: 'merged', baseRev: made.rev, body: `${typed}\nAGENT-AFTER-CREATE\n` })
  }, 20_000)

  it('upsert_note whose body rewrites the line the person typed in is not applied, and keeps a proposal', async () => {
    const path = 'docs/upsert-conflict'
    const text = await noteInTab(path)
    const read = await must<Read>('read_note', { vaultId, path })
    const typed = await type(path, text, 'two.', 'TYPED ')
    const r = await must<{ status: string; created: boolean; proposalId: string }>('upsert_note', { vaultId, path, body: read.body.replace('Para two.', 'Para 2.') })
    expect(r).toMatchObject({ status: 'conflicted', created: false, baseRev: read.rev, conflicts: { lines: [{ line: 3, removed: 1, added: 1 }] } })
    expect(r.proposalId).toMatch(/^[0-9a-f-]{36}$/)
    await sleep(300)
    expect(text.toString()).toBe(typed)
  }, 20_000)

  it('REST PUT with `baseRev` (the `rev` REST GET returned) merges: typing done after the GET stays (S1 shape)', async () => {
    const path = 'docs/put-s1'
    const text = await noteInTab(path)
    await typeAtEnd(path, text, ' p01 p0')
    const got = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie } })
    const read = got.json<{ body: string; rev: number }>()
    const typed = await typeAtEnd(path, text, '2 p03 p')
    const res = await put(path, { body: appended(read.body, 'SAVED-BY-CLIENT'), baseRev: read.rev })
    expect(res.statusCode, res.body).toBe(200)
    const expected = `${typed}\nSAVED-BY-CLIENT\n`
    expect(res.json()).toMatchObject({ body: expected, status: 'merged', baseRev: read.rev, concurrentChanges: { lines: [{ line: 6, removed: 1, added: 1 }] } })
    await waitFor(() => text.toString() === expected && liveBody(path) === expected)
  }, 20_000)

  it('REST PUT with `baseRev` whose body overlaps typing answers 409 with a proposal and changes nothing', async () => {
    const path = 'docs/put-conflict'
    const text = await noteInTab(path)
    const read = await must<Read>('read_note', { vaultId, path })
    const typed = await type(path, text, 'two.', 'TYPED ')
    const res = await put(path, { body: read.body.replace('Para two.', 'Para 2.'), baseRev: read.rev })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ status: 'conflicted', baseRev: read.rev, conflicts: { lines: [{ line: 3, removed: 1, added: 1 }] } })
    expect(res.json<{ proposalId: string }>().proposalId).toMatch(/^[0-9a-f-]{36}$/)
    await sleep(300)
    expect(text.toString()).toBe(typed)
    expect(await rowBody(path)).toBe(typed)
  }, 20_000)

  it('REST PUT refuses a `baseRev` that is not a revision of the note (400), and changes nothing', async () => {
    const path = 'docs/put-bad-base'
    await noteInTab(path)
    for (const baseRev of [999, 'not-a-revision']) {
      const res = await put(path, { body: 'Replaced.\n', baseRev })
      expect(res.statusCode, `${String(baseRev)}: ${res.body}`).toBe(400)
      expect(res.json<{ error: string }>().error).toMatch(/baseRev/)
    }
    expect(await rowBody(path)).toBe(BODY)
  }, 20_000)
})

describe('whole-markdown writes reach the live document as a diff (#476)', () => {
  /** Counts the characters deleted by every change the person's tab receives. */
  function countDeletes(text: Y.Text): { deleted: number } {
    const count = { deleted: 0 }
    text.observe((event) => {
      for (const op of event.delta) count.deleted += op.delete ?? 0
    })
    return count
  }

  it('REST PUT with a whole body changes only the characters that differ', async () => {
    const path = 'docs/whole-put'
    const text = await noteInTab(path)
    const seen = countDeletes(text)
    const body = BODY.replace('two', 'TWO')
    const put = await app.inject({ method: 'PUT', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie }, body: { body } })
    expect(put.statusCode, put.body).toBe(200)
    await waitFor(() => text.toString() === body)
    expect(seen.deleted).toBe(3)
  })

  it('revert reaches the live document as a diff from its text', async () => {
    const path = 'docs/whole-revert'
    const text = await noteInTab(path)
    const created = (await history(path)).at(-1)!.id
    await must('edit_note', { vaultId, path, body: BODY.replace('three', 'THREE') })
    await waitFor(() => text.toString().includes('THREE'))
    const seen = countDeletes(text)
    await must('revert_note', { vaultId, path, revisionId: created })
    await waitFor(() => text.toString() === BODY)
    expect(seen.deleted).toBe(5)
  })
})
