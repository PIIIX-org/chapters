// #482: an agent's edits land as individual revisions among the relay's and
// people's saves, so undoing everything one agent did meant finding the right
// older revision by hand. Before an MCP connection's first write to a note in
// a session (the connection, until it has recorded nothing on that note for
// 30 minutes), the note's current state is now kept as a `restore_point`
// revision attributed to that connection: one revert to it undoes the session.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, asc, eq, sql } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteRevisions } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote, getLiveNote, updateNote } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>

interface HistoryRow {
  id: string
  action: string
  actorType: string
  actorId: string | null
  actorName?: string | null
}

let app: FastifyInstance
let collab: CollabRelay
let baseUrl: string
let ownerCookie: string
let ownerId: string
let vaultId: string
let alpha: Client
let beta: Client
let alphaId: string
let betaId: string
const clients: Client[] = []

/** `n` distinct paragraphs (no paragraph repeats another), about 120 bytes each. */
function paragraphs(tag: string, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push(`${tag} paragraph ${i}: the ${i * 7}th observation about item ${i * 13 + 5} notes that value ${i * 31 + 2} changed after run ${i}.`)
  }
  return out.join('\n\n')
}

async function connect(name: string): Promise<{ client: Client; id: string }> {
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie: ownerCookie }, body: { name, scope: 'account' } })
  if (minted.statusCode !== 200) throw new Error(`mint failed: ${minted.statusCode} ${minted.body}`)
  const { token, id } = minted.json<{ token: string; id: string }>()
  const client = new Client({ name: `${name}-test`, version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return { client, id }
}

async function call(client: Client, name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function must<T>(client: Client, name: string, args: Args): Promise<T> {
  const r = await call(client, name, args)
  if (r.isError) throw new Error(`${name} failed: ${r.text}`)
  return JSON.parse(r.text) as T
}

async function personNote(path: string, body: string): Promise<string> {
  return (await createNote(vaultId, { path, body }, { type: 'user', id: ownerId })).id
}

async function restorePoints(noteId: string) {
  return db
    .select()
    .from(noteRevisions)
    .where(and(eq(noteRevisions.noteId, noteId), eq(noteRevisions.action, 'restore_point')))
    .orderBy(asc(noteRevisions.createdAt))
}

/** Lets `minutes` pass for the note: every revision recorded on it moves that far into the past. */
async function elapse(noteId: string, minutes: number): Promise<void> {
  await db
    .update(noteRevisions)
    .set({ createdAt: sql`${noteRevisions.createdAt} - make_interval(mins => ${minutes})` })
    .where(eq(noteRevisions.noteId, noteId))
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  ownerId = owner.id
  ownerCookie = await loginCookie(app, owner.email)
  const vault = await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie: ownerCookie }, body: { name: 'Restore points' } })
  vaultId = vault.json<{ id: string }>().id
  ;({ client: alpha, id: alphaId } = await connect('agent-alpha'))
  ;({ client: beta, id: betaId } = await connect('agent-beta'))
})

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await collab.destroy()
  await app.close()
})

describe('restore point before an agent edits a note (#482)', () => {
  const path = 'docs/restore-point'
  const original = paragraphs('original', 8)
  let noteId: string

  beforeAll(async () => {
    noteId = await personNote(path, original)
  })

  it("keeps the note's state before the connection's first edit, even when it equals the latest revision", async () => {
    await must(alpha, 'edit_note', { vaultId, path, body: `${original}\n\nalpha one` })
    const points = await restorePoints(noteId)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ actorType: 'mcp', actorId: alphaId, body: original })

    // Newest first; the relay's own store of the edit ('collab') may sit beside the agent's update.
    const history = await must<{ revisions: HistoryRow[] }>(alpha, 'note_history', { vaultId, path })
    const own = history.revisions.filter((r) => r.actorType !== 'collab')
    expect(own.map((r) => [r.action, r.actorType])).toEqual([
      ['update', 'mcp'],
      ['restore_point', 'mcp'],
      ['create', 'user'],
    ])
    expect(own[1]).toMatchObject({ id: points[0]!.id, actorId: alphaId, actorName: 'agent-alpha' })
  })

  it('adds no second restore point for later edits in the same session', async () => {
    await must(alpha, 'edit_note', { vaultId, path, body: `${original}\n\nalpha two` })
    await must(alpha, 'edit_note', { vaultId, path, frontmatter: { title: 'Alpha title' } })
    expect(await restorePoints(noteId)).toHaveLength(1)
  })

  it('gives another connection its own restore point of the state it found', async () => {
    await must(beta, 'edit_note', { vaultId, path, body: `${original}\n\nbeta one` })
    const points = await restorePoints(noteId)
    expect(points).toHaveLength(2)
    expect(points[1]).toMatchObject({ actorId: betaId, body: `${original}\n\nalpha two` })
    expect(points[1]!.frontmatter).toMatchObject({ title: 'Alpha title' })
  })

  it('one revert to the restore point undoes everything the agent did in the session', async () => {
    const [alphaPoint] = await restorePoints(noteId)
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/revert/${path}`,
      headers: { cookie: ownerCookie },
      body: { revisionId: alphaPoint!.id },
    })
    expect(res.statusCode, res.body).toBe(200)
    const row = await getLiveNote(vaultId, path)
    expect(row?.body).toBe(original)
    expect(row?.frontmatter).not.toHaveProperty('title')
    // The restore point itself stays what it was.
    expect((await restorePoints(noteId))[0]).toMatchObject({ id: alphaPoint!.id, action: 'restore_point' })
  })

  it('starts a new session after 30 idle minutes on the note', async () => {
    await elapse(noteId, 31)
    await must(alpha, 'edit_note', { vaultId, path, body: `${original}\n\nalpha later` })
    const points = await restorePoints(noteId)
    expect(points).toHaveLength(3)
    expect(points[2]).toMatchObject({ actorId: alphaId, body: original })
  })

  it('the REST history carries the agent name for the History tab', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/history/${path}`, headers: { cookie: ownerCookie } })
    expect(res.statusCode).toBe(200)
    const rows = res.json<HistoryRow[]>()
    const points = rows.filter((r) => r.action === 'restore_point')
    expect(points.map((r) => r.actorName).sort()).toEqual(['agent-alpha', 'agent-alpha', 'agent-beta'])
    expect(rows.find((r) => r.actorType === 'user')).toMatchObject({ actorName: null })
  })
})

describe('restore point edge cases (#482)', () => {
  it('a refused write keeps no restore point; the first write that lands keeps one', async () => {
    const path = 'docs/restore-point-quarantine'
    const body = paragraphs('quarantine', 40)
    const noteId = await personNote(path, body)
    const doubled = `${body}\n\n${body}`
    const first = await call(alpha, 'edit_note', { vaultId, path, body: doubled })
    expect(first.isError).toBe(true)
    expect(first.text).toMatch(/quarantine/i)
    expect((await call(alpha, 'edit_note', { vaultId, path, body: 'x', frontmatter: { status: 'not-a-status' } })).isError).toBe(true)
    expect(await restorePoints(noteId)).toHaveLength(0)
    await must(alpha, 'edit_note', { vaultId, path, body: `${body}\n\nshort addition` })
    expect(await restorePoints(noteId)).toMatchObject([{ actorId: alphaId, body }])
  })

  it('a new session keeps a restore point equal to the latest revision, but not twice the same one', async () => {
    const path = 'docs/restore-point-same-state'
    const noteId = await personNote(path, 'as found')
    await must(alpha, 'edit_note', { vaultId, path, body: 'as alpha left it' })
    await elapse(noteId, 31)
    // A new session: kept although the latest revision (alpha's own update) holds this state.
    await must(alpha, 'edit_note', { vaultId, path, body: 'as alpha left it' })
    expect((await restorePoints(noteId)).map((p) => p.body)).toEqual(['as found', 'as alpha left it'])
    // That write changed nothing, so the latest revision is that restore point: no second one of the same state.
    await elapse(noteId, 31)
    await must(alpha, 'edit_note', { vaultId, path, body: 'as alpha left it' })
    expect((await restorePoints(noteId)).map((p) => p.body)).toEqual(['as found', 'as alpha left it'])
  })

  it('a person editing in between does not end the session; a note the agent created needs none', async () => {
    const path = 'docs/restore-point-created'
    const { id } = await must<{ id: string }>(alpha, 'create_note', { vaultId, path, body: 'made by alpha' })
    await updateNote(vaultId, path, { body: 'a person edits' }, { type: 'user', id: ownerId })
    await must(alpha, 'edit_note', { vaultId, path, body: 'alpha again' })
    expect(await restorePoints(id)).toHaveLength(0)
  })

  it('revert_note, rename_note and delete_note keep a restore point first', async () => {
    const reverted = 'docs/restore-point-revert'
    const revertedId = await personNote(reverted, 'first')
    const [created] = await db.select().from(noteRevisions).where(eq(noteRevisions.noteId, revertedId))
    await updateNote(vaultId, reverted, { body: 'second' }, { type: 'user', id: ownerId })
    await must(beta, 'revert_note', { vaultId, path: reverted, revisionId: created!.id })
    expect(await restorePoints(revertedId)).toMatchObject([{ actorId: betaId, body: 'second' }])

    const renamed = 'docs/restore-point-rename'
    const renamedId = await personNote(renamed, 'to rename')
    await must(beta, 'rename_note', { vaultId, from: renamed, toName: 'restore-point-renamed' })
    expect(await restorePoints(renamedId)).toMatchObject([{ actorId: betaId, body: 'to rename' }])

    const deleted = 'docs/restore-point-delete'
    const deletedId = await personNote(deleted, 'to delete')
    await must(beta, 'delete_note', { vaultId, path: deleted })
    expect(await restorePoints(deletedId)).toMatchObject([{ actorId: betaId, body: 'to delete' }])
  })

  it('rename_note then delete_note from one connection records the delete', async () => {
    const path = 'docs/restore-point-rename-delete'
    const noteId = await personNote(path, 'renamed then deleted')
    // The rename records no revision, so this connection's restore point is the newest one.
    await must(alpha, 'rename_note', { vaultId, from: path, toName: 'restore-point-rename-deleted' })
    await must(alpha, 'delete_note', { vaultId, path: 'docs/restore-point-rename-deleted' })
    const rows = await db.select().from(noteRevisions).where(eq(noteRevisions.noteId, noteId)).orderBy(asc(noteRevisions.createdAt))
    expect(rows.map((r) => [r.action, r.actorType, r.actorId])).toEqual([
      ['create', 'user', ownerId],
      ['restore_point', 'mcp', alphaId],
      ['delete', 'mcp', alphaId],
    ])
  })

  it('edit_note then delete_note from one connection records the delete', async () => {
    const path = 'docs/restore-point-edit-delete'
    const noteId = await personNote(path, 'edited then deleted')
    await must(alpha, 'edit_note', { vaultId, path, body: 'alpha edit' })
    await must(alpha, 'delete_note', { vaultId, path })
    const own = (await db.select().from(noteRevisions).where(eq(noteRevisions.noteId, noteId)).orderBy(asc(noteRevisions.createdAt))).filter(
      (r) => r.actorType !== 'collab',
    )
    expect(own.map((r) => [r.action, r.actorType])).toEqual([
      ['create', 'user'],
      ['restore_point', 'mcp'],
      ['update', 'mcp'],
      ['delete', 'mcp'],
    ])
  })

  it('concurrent first writes from one connection keep one restore point', async () => {
    const path = 'docs/restore-point-concurrent'
    const noteId = await personNote(path, 'before the burst')
    await Promise.all([
      must(alpha, 'edit_note', { vaultId, path, body: 'burst one' }),
      must(alpha, 'edit_note', { vaultId, path, frontmatter: { title: 'Burst' } }),
      must(alpha, 'edit_note', { vaultId, path: `${path}.md`, body: 'burst three' }),
    ])
    expect(await restorePoints(noteId)).toMatchObject([{ actorId: alphaId, body: 'before the burst' }])
  })
})
