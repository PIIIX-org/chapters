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
//   writes files one by one and the commit/tree at its end.
// - edit_note and upsert_note answer the `rev` a later `if_rev` takes; a
//   not-modified answer leaves the connection's last-read record alone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { mcpConnections, noteReads, repositoryShares, vaultShares } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote, renameNote, softDeleteNote, updateNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

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
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'if-rev vault' } })).json<{ id: string }>().id
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'if-rev-repo', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'if-rev-owner', scope: 'account' } })
  owner = await mcpClient(minted.json<{ token: string }>().token)
  ownerConnectionId = (await db.select({ id: mcpConnections.id }).from(mcpConnections).where(eq(mcpConnections.name, 'if-rev-owner')))[0]!.id

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
  it('answers unchanged under 50 tokens for the current rev, and leaves the last-read record alone', async () => {
    const full = await readNote({ path: 'docs/guide' })
    const rev = full.json.rev as number
    expect(rev).toEqual(expect.any(Number))
    const [before] = await db.select().from(noteReads).where(eq(noteReads.connectionId, ownerConnectionId))
    const r = await readNote({ path: 'docs/guide', if_rev: String(rev) })
    expectUnchanged(r, 'rev', rev)
    const [after] = await db.select().from(noteReads).where(eq(noteReads.connectionId, ownerConnectionId))
    expect(after).toEqual(before)
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

  it('takes the rev edit_note and upsert_note answer', async () => {
    await createNote(vaultId, { path: 'docs/written', body: 'start\n' })
    const edited = await ok(owner, 'edit_note', { vaultId, path: 'docs/written', body: 'edited\n' })
    const editRev = edited.json.rev as number
    expectUnchanged(await readNote({ path: 'docs/written', if_rev: String(editRev) }), 'rev', editRev)
    const upserted = await ok(owner, 'upsert_note', { vaultId, path: 'docs/written', body: 'upserted\n' })
    const upsertRev = upserted.json.rev as number
    expect(upsertRev).toBe(editRev + 1)
    expectUnchanged(await readNote({ path: 'docs/written', if_rev: String(upsertRev) }), 'rev', upsertRev)
    expect((await readNote({ path: 'docs/written', if_rev: String(editRev) })).json.rev).toBe(upsertRev)
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
    expect(after.json.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('answers the access error, not unchanged, once the repository share is revoked', async () => {
    await db.insert(repositoryShares).values({ repositoryId: repoId, granteeType: 'user', granteeId: guestId })
    const seen = await readFile({ path: 'src/other.ts' }, guest)
    const hash = seen.json.hash as string
    expectUnchanged(await readFile({ path: 'src/other.ts', if_rev: hash }, guest), 'hash', hash)
    await db.delete(repositoryShares).where(and(eq(repositoryShares.repositoryId, repoId), eq(repositoryShares.granteeId, guestId)))
    const revoked = await call(guest, 'read_file', { repositoryId: repoId, path: 'src/other.ts', if_rev: hash })
    expect(revoked.isError).toBe(true)
    expect(revoked.json).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })
})
