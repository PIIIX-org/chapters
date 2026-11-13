// #682 (ADR-004 §2.9): read_note and read_file take `if_rev`, the version an
// earlier answer gave: a note's `rev`, a file's `hash`. When it is still the
// current one, the read answers `{unchanged: true, rev | hash, truncated:
// false}` (well under 50 tokens, characters / 4 as benchmarks/lib/metrics.ts
// `estimateTokens` counts) instead of the content, for a body, `targets` or
// `outline` read alike; any other value answers in full.
//
// - The revision is compared, not the content: a note changed and changed
//   back has a new `rev`, so it answers in full.
// - The access check comes first: a caller whose share was revoked gets the
//   access error, never `unchanged`.
// - A note's `rev` restarts at 1 for a new note, so a note created where
//   another was deleted or renamed from answers in full.
// - A file's `hash` is the token, not the repository `commit`/`tree`: a sync
//   writes files one by one and the commit/tree at its end. While the file's
//   outline lags its content (`index`), the token is `<hash>~pending` (or
//   `~failed`), which never answers `unchanged`.
// - edit_note and upsert_note answer the `rev` a later `if_rev` takes, as
//   the integer they give. A not-modified answer moves the connection's
//   last-read base to that rev (it holds it), keeping a body it sent there.
// - Only a first page answers `unchanged`: a cursor continues the answer it
//   came from, and is stale once the content changed.
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { FastifyInstance } from 'fastify'
import { and, eq, sql } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteReads, noteRevisions, repositoryFiles, repositoryShares, vaultShares } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { appendCollabUpdate, createNote, loadCollabState, purgeNote, renameNote, softDeleteNote, updateNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction, scheduleMissingExtractions } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'
import { metricsSnapshot, metricsText } from '../src/monitoring/metrics.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import * as search from '../src/search/search.js'

type Json = Record<string, unknown>
interface Result {
  isError: boolean
  json: Json
  structured: Json | undefined
  /** Characters of every content block, as an agent receives them. */
  chars: number
}

let app: FastifyInstance
let baseUrl: string
let vaultId: string
let repoId: string
let ownerCookie: string
let ownerConnectionId: string
let owner: Client
let guest: Client
let guestId: string
const clients: Client[] = []

const GUIDE = ['# Setup', 'Install it.', '## Linux', 'apt install x', '# Usage', 'Run it.', ''].join('\n')
const STORE_TS = ['export class Store {', '  save(x: string) {', '    return x', '  }', '}', ''].join('\n')

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'read-if-rev-test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return client
}

async function call(client: Client, tool: string, args: Json): Promise<Result> {
  resetRateLimits()
  const result = await client.callTool({ name: tool, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  const texts = content.map((c) => c.text ?? '')
  let json: Json
  try {
    json = JSON.parse(texts[0]!) as Json
  } catch {
    json = { text: texts[0] }
  }
  return { isError: result.isError === true, json, structured: result.structuredContent as Json | undefined, chars: texts.join('\n').length }
}

async function ok(client: Client, tool: string, args: Json): Promise<Result> {
  const r = await call(client, tool, args)
  expect(r.isError, `${tool} ${JSON.stringify(args)}: ${JSON.stringify(r.json).slice(0, 300)}`).toBe(false)
  return r
}

const readNote = (args: Json, client = owner) => ok(client, 'read_note', { vaultId, ...args })
const readFile = (args: Json, client = owner) => ok(client, 'read_file', { repositoryId: repoId, ...args })

/** A not-modified answer: `{unchanged: true, <key>: token, truncated: false}`, the same in structuredContent, under 50 tokens. */
function expectUnchanged(r: Result, key: 'rev' | 'hash', token: unknown): void {
  expect(r.json).toEqual({ unchanged: true, [key]: token, truncated: false })
  expect(r.structured).toEqual(r.json)
  expect(Math.ceil(r.chars / 4), `${r.chars} chars`).toBeLessThan(50)
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const ownerUser = await createActiveUser()
  const cookie = await loginCookie(app, ownerUser.email)
  ownerCookie = cookie
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'if-rev vault' } })).json<{ id: string }>().id
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'if-rev-repo', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'if-rev-owner', scope: 'account' } })
  owner = await mcpClient(minted.json<{ token: string }>().token)
  ownerConnectionId = minted.json<{ id: string }>().id

  const guestUser = await createActiveUser()
  guestId = guestUser.id
  const guestCookie = await loginCookie(app, guestUser.email)
  const guestToken = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie: guestCookie }, body: { name: 'if-rev-guest', scope: 'account', profile: 'reader' } })
  guest = await mcpClient(guestToken.json<{ token: string }>().token)

  await createNote(vaultId, { path: 'docs/guide', frontmatter: { title: 'Guide' }, body: GUIDE })
  const files = [{ path: 'src/store.ts', content: STORE_TS }, { path: 'src/other.ts', content: 'export const other = 1\n' }]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await flushExtraction()
}, 180_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('read_note if_rev (#682)', () => {
  it('answers unchanged under 50 tokens for the current rev, and keeps the last-read base at that rev', async () => {
    const full = await readNote({ path: 'docs/guide' })
    const rev = full.json.rev as number
    expect(rev).toEqual(expect.any(Number))
    const [before] = await db.select().from(noteReads).where(eq(noteReads.connectionId, ownerConnectionId))
    const r = await readNote({ path: 'docs/guide', if_rev: String(rev) })
    expectUnchanged(r, 'rev', rev)
    const [after] = await db.select().from(noteReads).where(eq(noteReads.connectionId, ownerConnectionId))
    expect({ rev: after!.rev, body: after!.body }).toEqual({ rev: before!.rev, body: before!.body })
  })

  it('moves the base a whole-body edit merges from to the rev it confirmed, so the edit does not conflict', async () => {
    await createNote(vaultId, { path: 'docs/probe', body: 'one\n' })
    const read = await readNote({ path: 'docs/probe' })
    const appended = await ok(owner, 'edit_note', { vaultId, path: 'docs/probe', ops: [{ op: 'append', text: 'two' }] })
    const rev = appended.json.rev as number
    expect(rev).toBe((read.json.rev as number) + 1)
    expectUnchanged(await readNote({ path: 'docs/probe', if_rev: String(rev) }), 'rev', rev)
    const edited = await ok(owner, 'edit_note', { vaultId, path: 'docs/probe', body: 'one\ntwo\nthree\n' })
    expect(edited.json).toMatchObject({ status: 'applied', body: 'one\ntwo\nthree\n', rev: rev + 1 })
  })

  it('keeps a body the connection sent at the confirmed rev (a merged whole-body write)', async () => {
    await createNote(vaultId, { path: 'docs/sent', body: 'a\n' })
    const read = await readNote({ path: 'docs/sent' })
    const [row] = await db.select({ noteId: noteReads.noteId }).from(noteReads).where(and(eq(noteReads.connectionId, ownerConnectionId), eq(noteReads.rev, read.json.rev as number)))
    await db.update(noteReads).set({ body: 'what it sent\n' }).where(and(eq(noteReads.connectionId, ownerConnectionId), eq(noteReads.noteId, row!.noteId)))
    expectUnchanged(await readNote({ path: 'docs/sent', if_rev: String(read.json.rev) }), 'rev', read.json.rev)
    const [kept] = await db.select().from(noteReads).where(and(eq(noteReads.connectionId, ownerConnectionId), eq(noteReads.noteId, row!.noteId)))
    expect({ rev: kept!.rev, body: kept!.body }).toEqual({ rev: read.json.rev, body: 'what it sent\n' })
  })

  it('answers in full for a stale rev, and for a note changed and changed back', async () => {
    await createNote(vaultId, { path: 'docs/flip', body: 'one\n' })
    const first = await readNote({ path: 'docs/flip' })
    const rev = first.json.rev as number
    await updateNote(vaultId, 'docs/flip', { body: 'two\n' })
    await updateNote(vaultId, 'docs/flip', { body: 'one\n' })
    const r = await readNote({ path: 'docs/flip', if_rev: String(rev) })
    expect(r.json).not.toHaveProperty('unchanged')
    expect(r.json.rev).toBe(rev + 2)
    expect(r.json.body).toEqual({ in: 'content[1]' })
    // A rev that is not a number, or one the note never had, is just not the current one.
    for (const other of ['abc', String(rev + 99), '']) {
      expect((await readNote({ path: 'docs/flip', if_rev: other })).json).not.toHaveProperty('unchanged')
    }
  })

  it('answers unchanged to targets and outline reads, and their parts again after a change', async () => {
    const targets = [{ heading: 'Setup > Linux' }]
    const part = await readNote({ path: 'docs/guide', targets })
    const rev = part.json.rev as number
    expectUnchanged(await readNote({ path: 'docs/guide', targets, if_rev: String(rev) }), 'rev', rev)
    const outline = await readNote({ path: 'docs/guide', outline: true })
    expect(outline.json.rev).toBe(rev)
    expectUnchanged(await readNote({ path: 'docs/guide', outline: true, if_rev: String(rev) }), 'rev', rev)

    await updateNote(vaultId, 'docs/guide', { body: GUIDE.replace('apt install x', 'apt install y') })
    const changed = await readNote({ path: 'docs/guide', targets, if_rev: String(rev) })
    expect(changed.json.rev).toBe(rev + 1)
    expect(changed.json.targets).toEqual([expect.objectContaining({ heading: 'Setup > Linux', text: '## Linux\napt install y\n' })])
    const outlined = await readNote({ path: 'docs/guide', outline: true, if_rev: String(rev) })
    expect(outlined.json).toHaveProperty('outline')
  })

  it('takes the rev edit_note and upsert_note answer, as the integer they give', async () => {
    await createNote(vaultId, { path: 'docs/written', body: 'start\n' })
    const edited = await ok(owner, 'edit_note', { vaultId, path: 'docs/written', body: 'edited\n' })
    const editRev = edited.json.rev as number
    expect(editRev).toEqual(expect.any(Number))
    expectUnchanged(await readNote({ path: 'docs/written', if_rev: editRev }), 'rev', editRev)
    const upserted = await ok(owner, 'upsert_note', { vaultId, path: 'docs/written', body: 'upserted\n' })
    const upsertRev = upserted.json.rev as number
    expect(upsertRev).toBe(editRev + 1)
    expectUnchanged(await readNote({ path: 'docs/written', if_rev: upsertRev }), 'rev', upsertRev)
    expectUnchanged(await readNote({ path: 'docs/written', if_rev: String(upsertRev) }), 'rev', upsertRev)
    expect((await readNote({ path: 'docs/written', if_rev: editRev })).json.rev).toBe(upsertRev)
  })

  it('keeps blind body writes as live replacements after actual CRDT typing, until an explicit read confirms a base', async () => {
    const path = 'docs/blind-write-identity'
    const note = await createNote(vaultId, { path, body: '@BASE@\ninitial body\nend base' })
    await ok(owner, 'edit_note', { vaultId, path, body: '@MCP07@\nfirst body\nend 07' })
    const { state } = await loadCollabState(vaultId, note.id)
    const tab = new Y.Doc()
    try {
      Y.applyUpdate(tab, state)
      const vector = Y.encodeStateVector(tab)
      tab.getText('body').insert(tab.getText('body').length, ' @TYPING@')
      expect(await appendCollabUpdate(vaultId, note.id, Y.encodeStateAsUpdate(tab, vector), { type: 'collab' })).not.toBeNull()
    } finally {
      tab.destroy()
    }
    const replacement = '@MCP08@\nsecond body\nend 08'
    const written = await ok(owner, 'edit_note', { vaultId, path, body: replacement })
    expect(written.json).toMatchObject({ status: 'applied', body: replacement })
    expect(written.json).not.toHaveProperty('baseRev')
    const reads = await db.select().from(noteReads).where(and(eq(noteReads.connectionId, ownerConnectionId), eq(noteReads.noteId, note.id)))
    expect(reads).toEqual([])
    expectUnchanged(await readNote({ path, if_rev: written.json.rev }), 'rev', written.json.rev)
    const confirmed = await db.select().from(noteReads).where(and(eq(noteReads.connectionId, ownerConnectionId), eq(noteReads.noteId, note.id)))
    expect(confirmed).toMatchObject([{ rev: written.json.rev }])
  })

  it('requires the exact successful writer revision, not another connection or a failed write', async () => {
    const path = 'docs/writer-identity'
    await createNote(vaultId, { path, body: 'original\n' })
    const written = await ok(owner, 'edit_note', { vaultId, path, body: 'written\n' })
    await db.insert(vaultShares).values({ vaultId, granteeType: 'user', granteeId: guestId, permission: 'read' })
    try {
      expect((await readNote({ path, if_rev: written.json.rev }, guest)).json).not.toHaveProperty('unchanged')
    } finally {
      await db.delete(vaultShares).where(and(eq(vaultShares.vaultId, vaultId), eq(vaultShares.granteeId, guestId)))
    }
    const changed = await updateNote(vaultId, path, { body: 'someone else changed it\n' })
    expect((await readNote({ path, if_rev: changed!.seq })).json).not.toHaveProperty('unchanged')

    const refusedPath = 'docs/refused-writer-identity'
    const original = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: distinct observation ${i * 17} with enough content to exercise the growth guard.`).join('\n\n')
    const refusedNote = await createNote(vaultId, { path: refusedPath, body: original })
    const refused = await call(owner, 'edit_note', { vaultId, path: refusedPath, body: `${original}\n\n${original}` })
    expect(refused.isError).toBe(true)
    const afterFailure = await readNote({ path: refusedPath, if_rev: refusedNote.seq })
    expect(afterFailure.json).not.toHaveProperty('unchanged')
    expect(afterFailure.structured?.body).toBe(original)

    const expiredPath = 'docs/expired-writer-identity'
    const expiredNote = await createNote(vaultId, { path: expiredPath, body: 'original\n' })
    const expiredWrite = await ok(owner, 'edit_note', { vaultId, path: expiredPath, body: 'written before the window\n' })
    await db.update(noteRevisions).set({ createdAt: sql`now() - interval '25 hours'` }).where(eq(noteRevisions.noteId, expiredNote.id))
    expect((await readNote({ path: expiredPath, if_rev: expiredWrite.json.rev })).json).not.toHaveProperty('unchanged')
  })

  it('answers in full for a note created where another note was deleted or renamed from', async () => {
    await createNote(vaultId, { path: 'docs/scratch', body: 'old\n' })
    const old = await readNote({ path: 'docs/scratch' })
    expect(old.json.rev).toBe(1)
    await softDeleteNote(vaultId, 'docs/scratch')
    await createNote(vaultId, { path: 'docs/scratch', body: 'new\n' })
    const recreated = await readNote({ path: 'docs/scratch', if_rev: '1' })
    expect(recreated.json).not.toHaveProperty('unchanged')
    expect(recreated.json.rev).toBe(1)

    await createNote(vaultId, { path: 'docs/moved', body: 'first\n' })
    expect((await readNote({ path: 'docs/moved' })).json.rev).toBe(1)
    await renameNote(vaultId, 'docs/moved', 'elsewhere')
    await createNote(vaultId, { path: 'docs/moved', body: 'second\n' })
    expect((await readNote({ path: 'docs/moved', if_rev: '1' })).json).not.toHaveProperty('unchanged')
  })

  it('answers the access error, not unchanged, once the share is revoked', async () => {
    await db.insert(vaultShares).values({ vaultId, granteeType: 'user', granteeId: guestId, permission: 'read' })
    const seen = await readNote({ path: 'docs/guide' }, guest)
    const rev = seen.json.rev as number
    expectUnchanged(await readNote({ path: 'docs/guide', if_rev: String(rev) }, guest), 'rev', rev)
    await db.delete(vaultShares).where(and(eq(vaultShares.vaultId, vaultId), eq(vaultShares.granteeId, guestId)))
    const revoked = await call(guest, 'read_note', { vaultId, path: 'docs/guide', if_rev: String(rev) })
    expect(revoked.isError).toBe(true)
    expect(revoked.json).toMatchObject({ error: { code: 'NOT_FOUND' } })
    expect(revoked.json).not.toHaveProperty('unchanged')
  })

  it('does not confuse a purged predecessor with a new note at the same path and numeric revision', async () => {
    const predecessor = await createNote(vaultId, { path: 'docs/purged-probe', body: 'old content\n' })
    const held = await readNote({ path: 'docs/purged-probe' })
    await softDeleteNote(vaultId, 'docs/purged-probe')
    await purgeNote(vaultId, predecessor.id)
    await createNote(vaultId, { path: 'docs/purged-probe', body: 'new content\n' })
    const recreated = await readNote({ path: 'docs/purged-probe', if_rev: held.json.rev })
    expect(recreated.json.rev).toBe(held.json.rev)
    expect(recreated.json).not.toHaveProperty('unchanged')
    expect(recreated.structured?.body).toBe('new content\n')
    expectUnchanged(await readNote({ path: 'docs/purged-probe', if_rev: recreated.json.rev }), 'rev', recreated.json.rev)
  })
})

describe('read_file if_rev (#682)', () => {
  it('exposes the file hash on every read and answers unchanged for it until a push changes the file', async () => {
    const full = await readFile({ path: 'src/store.ts' })
    const hash = full.json.hash as string
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expectUnchanged(await readFile({ path: 'src/store.ts', if_rev: hash }), 'hash', hash)
    expectUnchanged(await readFile({ path: 'src/store.ts', targets: [{ symbol: 'Store.save' }], if_rev: hash }), 'hash', hash)
    expectUnchanged(await readFile({ path: 'src/store.ts', outline: true, if_rev: hash }), 'hash', hash)
    // The repository version is not the file's: it is answered in full.
    const tree = full.json.tree as string
    expect(tree).toMatch(/^[0-9a-f]{16}$/)
    expect((await readFile({ path: 'src/store.ts', if_rev: tree })).json).not.toHaveProperty('unchanged')

    // A push that changes another file leaves this one unchanged; one that changes it answers in full.
    const keep = { path: 'src/store.ts', content: STORE_TS }
    await syncRepositoryFiles(repoId, [keep, { path: 'src/other.ts', content: 'export const other = 2\n' }], ['src/store.ts', 'src/other.ts'])
    expectUnchanged(await readFile({ path: 'src/store.ts', if_rev: hash }), 'hash', hash)
    const changed = STORE_TS.replace('return x', 'return x + x')
    await syncRepositoryFiles(repoId, [{ path: 'src/store.ts', content: changed }], ['src/store.ts', 'src/other.ts'])
    const after = await readFile({ path: 'src/store.ts', if_rev: hash })
    expect(after.json).not.toHaveProperty('unchanged')
    expect(after.json.hash).not.toBe(hash)
    expect(after.json.hash).toMatch(/^[0-9a-f]{16}(~pending)?$/)
  })

  it('serves `<hash>~pending` while the outline lags, which never answers unchanged, then the symbols once indexed', async () => {
    const v1 = 'export function first() {\n  return 1\n}\n'
    await syncRepositoryFiles(repoId, [{ path: 'src/late.ts', content: v1 }], ['src/store.ts', 'src/other.ts', 'src/late.ts'])
    await flushExtraction()
    // The stored content moved on and its extraction has not run yet (as repository-indexed-version.test.ts does).
    const v2 = 'export function second() {\n  return 2\n}\n'
    const contentHash = createHash('sha256').update(v2).digest('hex')
    await db.update(repositoryFiles).set({ content: v2, contentHash }).where(and(eq(repositoryFiles.repositoryId, repoId), eq(repositoryFiles.path, 'src/late.ts')))
    const targets = [{ symbol: 'second' }]
    const pending = await readFile({ path: 'src/late.ts', targets })
    const token = `${contentHash.slice(0, 16)}~pending`
    expect(pending.json).toMatchObject({ index: 'pending', hash: token })
    expect(pending.json.targets).toEqual([expect.objectContaining({ symbol: 'second', error: expect.objectContaining({ code: 'NOT_FOUND' }) })])
    expect((await readFile({ path: 'src/late.ts', targets, if_rev: token })).json).toMatchObject({ hash: token })
    expect((await readFile({ path: 'src/late.ts', targets, if_rev: contentHash.slice(0, 16) })).json).toMatchObject({ hash: token })

    await scheduleMissingExtractions()
    await flushExtraction()
    const ready = await readFile({ path: 'src/late.ts', targets, if_rev: token })
    expect(ready.json).not.toHaveProperty('unchanged')
    expect(ready.json).not.toHaveProperty('index')
    expect(ready.json.hash).toBe(contentHash.slice(0, 16))
    expect(ready.json.targets).toEqual([expect.objectContaining({ symbol: 'second', text: v2 })])
    expectUnchanged(await readFile({ path: 'src/late.ts', targets, if_rev: ready.json.hash }), 'hash', ready.json.hash)
  })

  it('pages on with a cursor rather than answering unchanged: a cursor from changed content is stale', async () => {
    const paths = ['src/store.ts', 'src/other.ts', 'src/late.ts', 'src/long.ts']
    const long = (tag: string) => Array.from({ length: 120 }, (_, i) => `export const ${tag}${i} = ${i} // a line of filler text`).join('\n') + '\n'
    await syncRepositoryFiles(repoId, [{ path: 'src/long.ts', content: long('a') }], paths)
    await flushExtraction()
    const held = (await readFile({ path: 'src/long.ts', budget_tokens: 256 })).json.hash as string
    await syncRepositoryFiles(repoId, [{ path: 'src/long.ts', content: long('b') }], paths)
    await flushExtraction()
    const first = await readFile({ path: 'src/long.ts', budget_tokens: 256, if_rev: held })
    const truncated = first.json.truncated as { cursor: string | null }
    expect(truncated.cursor).toEqual(expect.any(String))
    // The file goes back to the version the agent holds while it pages the other one.
    await syncRepositoryFiles(repoId, [{ path: 'src/long.ts', content: long('a') }], paths)
    await flushExtraction()
    const next = await call(owner, 'read_file', { repositoryId: repoId, path: 'src/long.ts', budget_tokens: 256, if_rev: held, cursor: truncated.cursor })
    expect(next.isError).toBe(true)
    expect(next.json).toMatchObject({ error: { code: 'CURSOR_STALE' } })
    expectUnchanged(await readFile({ path: 'src/long.ts', budget_tokens: 256, if_rev: held }), 'hash', held)
  })

  it('answers the access error, not unchanged, once the repository share is revoked', async () => {
    await db.insert(repositoryShares).values({ repositoryId: repoId, granteeType: 'user', granteeId: guestId })
    await flushExtraction()
    const seen = await readFile({ path: 'src/other.ts' }, guest)
    const hash = seen.json.hash as string
    expectUnchanged(await readFile({ path: 'src/other.ts', if_rev: hash }, guest), 'hash', hash)
    await db.delete(repositoryShares).where(and(eq(repositoryShares.repositoryId, repoId), eq(repositoryShares.granteeId, guestId)))
    const revoked = await call(guest, 'read_file', { repositoryId: repoId, path: 'src/other.ts', if_rev: hash })
    expect(revoked.isError).toBe(true)
    expect(revoked.json).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })
})

describe('search if_rev and the scoped result cache (#680, #682)', () => {
  it('serves a repeat from cache, renders each budget separately, and confirms a current revision under 50 tokens', async () => {
    await flushEmbeddings()
    const args = { vaultId, query: 'Guide setup install' }
    const before = metricsSnapshot()
    const first = await ok(owner, 'search', args)
    expect(first.json.rev).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/))
    expect((await ok(owner, 'search', args)).json).toEqual(first.json)
    expectUnchanged(await ok(owner, 'search', { ...args, if_rev: first.json.rev, budget_tokens: 256 }), 'rev', first.json.rev)
    const after = metricsSnapshot()
    expect(after).toHaveProperty('caches.search', { hit: expect.any(Number), miss: expect.any(Number) })
    expect(after.caches.search!.miss - before.caches.search!.miss).toBe(1)
    expect(after.caches.search!.hit - before.caches.search!.hit).toBe(2)
    expect(metricsText()).toContain(`elara_cache_lookups_total{cache="search",outcome="hit"} ${after.caches.search!.hit}`)
  })

  it('returns new full results after a write, never the prior cached snippets', async () => {
    await createNote(vaultId, { path: 'docs/cache-probe', body: 'Cacheprobe before content.\n' })
    await flushEmbeddings()
    const args = { vaultId, query: 'Cacheprobe', symbols: false }
    const first = await ok(owner, 'search', args)
    await updateNote(vaultId, 'docs/cache-probe', { body: 'Cacheprobe after content.\n' })
    await flushEmbeddings()
    const changed = await ok(owner, 'search', { ...args, if_rev: first.json.rev })
    expect(changed.json).not.toHaveProperty('unchanged')
    expect(changed.json.rev).not.toBe(first.json.rev)
    expect(JSON.stringify(changed.json.results)).toContain('after content')
    expect(JSON.stringify(changed.json.results)).not.toContain('before content')
  })

  it('isolates accounts, profiles and pins, then refuses a revoked share before consulting cache', async () => {
    await db.insert(vaultShares).values({ vaultId, granteeType: 'user', granteeId: guestId, permission: 'read' })
    const pinned = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie: ownerCookie }, body: { name: 'cache-pin', scope: 'vault', vaultId, profile: 'reader' } })
    const reader = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie: ownerCookie }, body: { name: 'cache-reader', scope: 'account', profile: 'reader' } })
    const pinClient = await mcpClient(pinned.json<{ token: string }>().token)
    const readerClient = await mcpClient(reader.json<{ token: string }>().token)
    await flushEmbeddings()
    const args = { vaultId, query: 'Guide setup install' }
    const own = await ok(owner, 'search', args)
    const shared = await ok(guest, 'search', { ...args, if_rev: own.json.rev })
    expect(shared.json).not.toHaveProperty('unchanged')
    expect(shared.json.rev).not.toBe(own.json.rev)
    for (const client of [pinClient, readerClient]) {
      const other = await ok(client, 'search', { ...args, if_rev: own.json.rev })
      expect(other.json).not.toHaveProperty('unchanged')
      expect(other.json.rev).not.toBe(own.json.rev)
    }
    expectUnchanged(await ok(guest, 'search', { ...args, if_rev: shared.json.rev }), 'rev', shared.json.rev)
    await db.delete(vaultShares).where(and(eq(vaultShares.vaultId, vaultId), eq(vaultShares.granteeId, guestId)))
    const before = metricsSnapshot().caches.search!
    const revoked = await call(guest, 'search', { ...args, if_rev: shared.json.rev })
    expect(revoked.isError).toBe(true)
    expect(revoked.json).toMatchObject({ error: { code: 'NOT_FOUND' } })
    expect(metricsSnapshot().caches.search).toEqual(before)
    const permitted = await ok(owner, 'search', { ...args, if_rev: own.json.rev })
    expect(permitted.json).not.toHaveProperty('unchanged')
  })

  it('does not cache or issue a revision for a result computed across an epoch change', async () => {
    const path = 'docs/epoch-race-probe'
    await createNote(vaultId, { path, body: 'Cacheepochrace before content.\n' })
    await flushEmbeddings()
    const original = search.searchNotes
    const spy = vi.spyOn(search, 'searchNotes').mockImplementationOnce(async (...args) => {
      const answer = await original(...args)
      await updateNote(vaultId, path, { body: 'Cacheepochrace concurrent change.\n' })
      return answer
    })
    try {
      const args = { vaultId, query: 'Cacheepochrace', symbols: false }
      const raced = await ok(owner, 'search', args)
      expect(raced.json).not.toHaveProperty('rev')
      await flushEmbeddings()
      const fresh = await ok(owner, 'search', args)
      expect(fresh.json.rev).toEqual(expect.any(String))
      expect(JSON.stringify(fresh.json.results)).toContain('concurrent change')
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('does not keep degraded results: recovery can occur without an epoch change', async () => {
    const original = search.searchNotes
    const spy = vi.spyOn(search, 'searchNotes').mockImplementationOnce(async (...args) => ({
      ...await original(...args), degraded: { reason: 'embedder_failed' as const },
    }))
    try {
      const args = { vaultId, query: 'unique degraded cache proof' }
      expect((await ok(owner, 'search', args)).json).not.toHaveProperty('rev')
      expect((await ok(owner, 'search', args)).json.rev).toEqual(expect.any(String))
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
  })
})
