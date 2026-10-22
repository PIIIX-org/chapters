// #492: a stale reload doubled a whole note (#488) and every write path
// stored it as an ordinary edit. A write that doubles a note (grows it to
// ≥ 1.9× a previous body of ≥ 2 KiB) or repeats a block of it (copies of
// text already in the note adding up to ≥ 1 KiB and half the note) is now
// quarantined: the row and the file keep the previous body, the refused body
// is kept as a `quarantine` revision, and the caller is told how to override
// (edit_note / REST PUT `allowGrowth: true`). The collab relay keeps the live
// document, does not store the duplicated body and reports it (#705).
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteRevisions } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { metricsSnapshot } from '../src/monitoring/metrics.js'
import { parseNote } from '../src/notes/okf.js'
import { getLiveNote, noteFile } from '../src/notes/store.js'
import { flushProjections } from '../src/notes/projector.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

type Args = Record<string, unknown>

let app: FastifyInstance
let collab: CollabRelay
let baseUrl: string
let ownerCookie: string
let ownerToken: string
let vaultId: string
let mcp: Client
const providers: HocuspocusProvider[] = []

/** `n` distinct paragraphs (no paragraph repeats another), about 120 bytes each. */
function paragraphs(tag: string, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push(`${tag} paragraph ${i}: the ${i * 7}th observation about item ${i * 13 + 5} notes that value ${i * 31 + 2} changed after run ${i}.`)
  }
  return out.join('\n\n')
}

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

/** The note's file once the projector has written every committed write (ADR-003 §7). */
async function fileBody(path: string): Promise<string> {
  await flushProjections()
  return parseNote(await readFile(noteFile(vaultId, path), 'utf8')).body
}

async function rowBody(path: string): Promise<string | undefined> {
  return (await getLiveNote(vaultId, path))?.body
}

async function quarantined(noteId: string) {
  return db
    .select()
    .from(noteRevisions)
    .where(and(eq(noteRevisions.noteId, noteId), eq(noteRevisions.action, 'quarantine')))
    .orderBy(desc(noteRevisions.ord))
}

/** Polls `check`: the relay stores on a debounce, and there is no event to await for a store's outcome. */
async function waitFor(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await sleep(50)
  }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  ownerToken = await loginToken(app, owner.email)
  const vault = await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie: ownerCookie }, body: { name: 'Growth quarantine' } })
  vaultId = vault.json<{ id: string }>().id
  const minted = await app.inject({
    method: 'POST',
    url: '/api/mcp-connections',
    headers: { cookie: ownerCookie },
    body: { name: 'growth-quarantine', scope: 'account' },
  })
  const { token } = minted.json<{ token: string }>()
  mcp = new Client({ name: 'growth-quarantine-test', version: '0.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  )
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await mcp.close()
  await collab.destroy()
  await app.close()
})

describe('MCP edit_note', () => {
  const path = 'docs/doubled-by-agent'
  const body = paragraphs('agent', 40) // ~5 KiB
  let noteId: string

  beforeAll(async () => {
    noteId = (await must<{ id: string }>('create_note', { vaultId, path, body })).id
  })

  it('quarantines an edit that doubles the note: row and file unchanged, clear error, refused body kept', async () => {
    const doubled = `${body}\n\n${body}`
    const r = await call('edit_note', { vaultId, path, body: doubled })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/quarantine/i)
    expect(r.text).toContain('allowGrowth')
    expect(await rowBody(path)).toBe(body)
    expect(await fileBody(path)).toBe(body)

    const [q] = await quarantined(noteId)
    expect(q?.body).toBe(doubled)
    expect(q?.actorType).toBe('mcp')
    expect(r.text).toContain(q!.id)
    // Retrievable the documented way: note_history lists it, get_revision returns it.
    const history = await must<{ revisions: Array<{ id: string; action: string }> }>('note_history', { vaultId, path })
    expect(history.revisions[0]).toMatchObject({ id: q!.id, action: 'quarantine' })
    const revision = await must<{ body: string; action: string }>('get_revision', { vaultId, path, revisionId: q!.id })
    expect(revision).toMatchObject({ body: doubled, action: 'quarantine' })
  })

  it('quarantines an edit that only repeats a large block of the note', async () => {
    const r = await call('edit_note', { vaultId, path, body: `${body}\n\nadded line\n\n${body.slice(0, Math.ceil(body.length * 0.6))}` })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/repeated/i)
    expect(await rowBody(path)).toBe(body)
  })

  it('allowGrowth: true writes the doubled body, recorded as an ordinary update', async () => {
    const doubled = `${body}\n\n${body}`
    const r = await call('edit_note', { vaultId, path, body: doubled, allowGrowth: true })
    expect(r.isError, r.text).toBe(false)
    expect(await rowBody(path)).toBe(doubled)
    expect(await fileBody(path)).toBe(doubled)
    const [newest] = await db
      .select()
      .from(noteRevisions)
      .where(eq(noteRevisions.noteId, noteId))
      .orderBy(desc(noteRevisions.ord))
      .limit(1)
    expect(newest).toMatchObject({ action: 'update', body: doubled })
  })

  it('revert_note restores a quarantined revision', async () => {
    const p = 'docs/revert-quarantined'
    const base = paragraphs('revert', 30)
    const id = (await must<{ id: string }>('create_note', { vaultId, path: p, body: base })).id
    const tripled = `${base}\n\n${base}\n\n${base}`
    expect((await call('edit_note', { vaultId, path: p, body: tripled })).isError).toBe(true)
    const [q] = await quarantined(id)
    const r = await call('revert_note', { vaultId, path: p, revisionId: q!.id })
    expect(r.isError, r.text).toBe(false)
    expect(await rowBody(p)).toBe(tripled)
  })
})

describe('REST PUT', () => {
  it('answers 409 naming the quarantine and the override, and allowGrowth writes', async () => {
    const path = 'docs/doubled-by-rest'
    const body = paragraphs('rest', 30)
    const created = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie: ownerCookie },
      body: { type: 'docs', name: 'doubled-by-rest', body },
    })
    expect(created.statusCode).toBe(200)
    const doubled = `${body}\n${body}`
    const refused = await app.inject({ method: 'PUT', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie: ownerCookie }, body: { body: doubled } })
    expect(refused.statusCode).toBe(409)
    expect(refused.body).toMatch(/quarantine/i)
    expect(refused.body).toContain('allowGrowth')
    expect(await rowBody(path)).toBe(body)
    expect(await fileBody(path)).toBe(body)

    const allowed = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/${path}`,
      headers: { cookie: ownerCookie },
      body: { body: doubled, allowGrowth: true },
    })
    expect(allowed.statusCode).toBe(200)
    expect(await rowBody(path)).toBe(doubled)
  })
})

describe('collab relay store', () => {
  it('does not persist a doubled live document, records and reports it, and stores the next legitimate state', async () => {
    const path = 'docs/doubled-by-relay'
    const body = paragraphs('relay', 25) // ~3 KiB
    const noteId = (await must<{ id: string }>('create_note', { vaultId, path, body })).id
    const before = metricsSnapshot().jobs['collab-store']

    const provider = new HocuspocusProvider({ url: `${baseUrl.replace('http', 'ws')}/collab`, name: `${vaultId}/~${noteId}`, token: ownerToken, document: new Y.Doc() })
    providers.push(provider)
    const text = provider.document.getText('body')
    await waitFor(() => text.toString() === body)

    // What a stale reload produces: the same text twice in the live document.
    text.insert(text.length, `\n\n${body}`)
    await waitFor(async () => (await quarantined(noteId)).length > 0 && metricsSnapshot().jobs['collab-store'].failed > before.failed)
    expect(await rowBody(path)).toBe(body)
    expect(await fileBody(path)).toBe(body)
    const [q] = await quarantined(noteId)
    expect(q).toMatchObject({ actorType: 'collab', body: `${body}\n\n${body}` })
    const reported = metricsSnapshot()
    expect(reported.jobs['collab-store'].failed).toBe(before.failed + 1)
    expect(reported.errors.at(-1)).toMatchObject({ type: 'job', job: 'collab-store', subjectId: vaultId, error: { name: 'NoteWriteQuarantinedError' } })
    // The editor keeps what it shows: nothing is reverted under the user.
    expect(text.toString()).toBe(`${body}\n\n${body}`)

    // Typing on while the document is still doubled updates the one quarantined revision; it is reported once.
    text.insert(text.length, ' typed-while-doubled')
    await waitFor(
      async () =>
        ((await quarantined(noteId))[0]?.body ?? '').endsWith(' typed-while-doubled') &&
        metricsSnapshot().jobs['collab-store'].repeated > before.repeated,
    )
    expect(await quarantined(noteId)).toHaveLength(1)
    expect(await rowBody(path)).toBe(body)
    const repeated = metricsSnapshot().jobs['collab-store']
    expect(repeated.failed).toBe(before.failed + 1)
    expect(repeated.repeated).toBeGreaterThan(before.repeated)

    // The user removes the duplicate and goes on: that store is written.
    provider.document.transact(() => {
      text.delete(body.length, text.length - body.length)
      text.insert(text.length, '\n\nlegit addition')
    })
    // The row is written before the file: wait for both.
    const legit = `${body}\n\nlegit addition`
    await waitFor(async () => (await rowBody(path)) === legit && (await fileBody(path)) === legit)
  })

  it('a quarantine after the document is unloaded and reloaded is a new revision: the first episode survives', async () => {
    const path = 'docs/two-episodes'
    const body = paragraphs('episode', 25)
    const noteId = (await must<{ id: string }>('create_note', { vaultId, path, body })).id
    const docName = `${vaultId}/~${noteId}`
    const before = metricsSnapshot().jobs['collab-store']
    const open = () => new HocuspocusProvider({ url: `${baseUrl.replace('http', 'ws')}/collab`, name: docName, token: ownerToken, document: new Y.Doc() })

    // Episode 1: doubled, typed into, then the tab closes and the document unloads.
    const first = open()
    const text1 = first.document.getText('body')
    await waitFor(() => text1.toString() === body)
    text1.insert(text1.length, `\n\n${body}\n\ntyped-in-episode-1`)
    await waitFor(async () => ((await quarantined(noteId))[0]?.body ?? '').endsWith('typed-in-episode-1'))
    first.destroy()
    await waitFor(() => !collab.hocuspocus.documents.has(docName), 15_000)

    // Episode 2: the reloaded document holds what was typed in episode 1 (ADR-003 S2b: refused typing stays in the
    // note's CRDT log with `fold_error`, the row keeps its last valid body), and is typed into again.
    const episode1 = `${body}\n\n${body}\n\ntyped-in-episode-1`
    const second = open()
    providers.push(second)
    const text2 = second.document.getText('body')
    await waitFor(() => text2.toString() === episode1)
    text2.insert(text2.length, '\n\ntyped-in-episode-2')
    await waitFor(async () => (await quarantined(noteId)).some((q) => q.body.endsWith('typed-in-episode-2')))

    const bodies = (await quarantined(noteId)).map((q) => q.body).sort()
    expect(bodies).toEqual([episode1, `${episode1}\n\ntyped-in-episode-2`])
    expect(await rowBody(path)).toBe(body)
    // Each episode is reported as a failure of its own.
    await waitFor(() => metricsSnapshot().jobs['collab-store'].failed >= before.failed + 2)
  })

  // #408 review: a refused edit_note with body `ops` opened its direct
  // connection as a checked write (`directWrite`), and the connection's store
  // on disconnect then skipped the relay's own quarantine, so the doubled live
  // document reached the row even though the edit was refused.
  it('a refused ops edit does not store a doubled live document past the relay quarantine', async () => {
    const path = 'docs/doubled-then-refused-ops'
    const body = paragraphs('ops', 18) // ~1.7 KiB
    const noteId = (await must<{ id: string }>('create_note', { vaultId, path, body })).id
    const provider = new HocuspocusProvider({ url: `${baseUrl.replace('http', 'ws')}/collab`, name: `${vaultId}/~${noteId}`, token: ownerToken, document: new Y.Doc() })
    providers.push(provider)
    const text = provider.document.getText('body')
    await waitFor(() => text.toString() === body)
    text.insert(text.length, `\n\n${body}`)
    await waitFor(async () => (await quarantined(noteId)).length > 0)
    expect(await rowBody(path)).toBe(body)

    const quarantinedOps = await call('edit_note', { vaultId, path, ops: [{ op: 'append', text: 'one more line' }] })
    expect(quarantinedOps.isError).toBe(true)
    expect(quarantinedOps.text).toMatch(/quarantined/)
    expect(await rowBody(path)).toBe(body)

    const ambiguous = await call('edit_note', { vaultId, path, ops: [{ op: 'insert_after', anchor: 'paragraph', text: '!' }] })
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toMatch(/occurs \d+ times/)
    expect(await rowBody(path)).toBe(body)
    expect(await fileBody(path)).toBe(body)
  })
})

describe('writes that are not quarantined', () => {
  it('a stub filled in, ordinary growth and a large first write pass', async () => {
    const stub = 'docs/stub-then-filled'
    await must('create_note', { vaultId, path: stub, body: 'TODO' })
    const filled = paragraphs('filled', 90) // ~11 KiB from 4 bytes
    expect((await call('edit_note', { vaultId, path: stub, body: filled })).isError).toBe(false)
    expect(await rowBody(stub)).toBe(filled)

    const grown = `${filled}\n\n${paragraphs('more', 50)}` // +~6 KiB on ~11 KiB: 1.5x
    const r = await call('edit_note', { vaultId, path: stub, body: grown })
    expect(r.isError, r.text).toBe(false)
    expect(await rowBody(stub)).toBe(grown)

    const big = paragraphs('big', 5000) // ~600 KiB first write
    const created = await call('create_note', { vaultId, path: 'docs/large-first-write', body: big })
    expect(created.isError, created.text).toBe(false)
    expect(await rowBody('docs/large-first-write')).toBe(big)
  })

  it('checks a ~1 MiB edit through MCP quickly', async () => {
    // ~640 KiB note, ~960 KiB edit: the largest repeat that fits under the 1 MiB request limit.
    const path = 'docs/one-mib'
    const body = paragraphs('mib', 6000).slice(0, 640 * 1024)
    await must('create_note', { vaultId, path, body })
    // Half of it repeated: quarantined, quickly. "Quickly" is this process's
    // CPU time (client and server both run here), not wall time: a loaded
    // machine stretches wall time without the check doing more work (#862:
    // 6.1 s wall under load), while a check that scaled badly with the size
    // would still burn the CPU.
    const repeated = `${body}\n\n${body.slice(0, 320 * 1024)}`
    let cpu = process.cpuUsage()
    const refused = await call('edit_note', { vaultId, path, body: repeated })
    const refusedCpu = process.cpuUsage(cpu)
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/quarantine/i)
    // An ordinary edit of the same note passes, also quickly.
    cpu = process.cpuUsage()
    const edited = await call('edit_note', { vaultId, path, body: `${body.slice(0, 1000)}EDITED${body.slice(1000)}` })
    const editedCpu = process.cpuUsage(cpu)
    expect(edited.isError, edited.text).toBe(false)
    expect((refusedCpu.user + refusedCpu.system) / 1000).toBeLessThan(5000)
    expect((editedCpu.user + editedCpu.system) / 1000).toBeLessThan(5000)
  })
})
