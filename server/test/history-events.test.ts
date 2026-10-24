// #479: delete, restore and rename are history events, and a revert is its
// own row. The delete revision went through the same-author dedupe, so an
// edit followed by a delete by the same actor left no trace of the delete;
// restore and rename recorded nothing; revert_note set `action = 'revert'`
// on whatever row was newest after its write, which, when the write was a
// repeat, relabelled an earlier edit and never said which revision came back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie, toolText } from './helpers.js'

type Args = Record<string, unknown>

interface HistoryRow {
  id: string
  action: string
  actorType: string
  actorId: string | null
  createdAt: string
  sourceRevisionId?: string
  fromPath?: string
  toPath?: string
}

let app: FastifyInstance
let baseUrl: string
let ownerId: string
let ownerCookie: string
let vaultId: string
let agent: Client
let counter = 0

/** `json[key]` as a string, or a thrown error naming what came back. */
function field(json: unknown, key: string): string {
  const value: unknown = json && typeof json === 'object' && key in json ? Reflect.get(json, key) : undefined
  if (typeof value !== 'string') throw new Error(`expected a string ${key}, got ${JSON.stringify(json)}`)
  return value
}

async function must<T>(name: string, args: Args): Promise<T> {
  resetRateLimits()
  const result = await agent.callTool({ name, arguments: { vaultId, ...args } })
  const content: unknown[] = Array.isArray(result.content) ? result.content : []
  const text = toolText(content)
  if (result.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text) as T
}

/** note_history of `path`, newest first. */
async function agentHistory(path: string): Promise<HistoryRow[]> {
  return (await must<{ revisions: HistoryRow[] }>('note_history', { path, limit: 100 })).revisions
}

async function rest(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: Args) {
  return app.inject({ method, url: `/api/vaults/${vaultId}${url}`, headers: { cookie: ownerCookie }, ...(body ? { body } : {}) })
}

/** The REST history list (the History tab) of `path`, newest first. */
async function restHistory(path: string): Promise<HistoryRow[]> {
  const res = await rest('GET', `/history/${path}?limit=200`)
  expect(res.statusCode).toBe(200)
  return res.json() as HistoryRow[]
}

async function agentNote(body = 'First body.'): Promise<{ id: string; path: string }> {
  return must('create_note', { path: `docs/history-event-${++counter}`, body })
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  ownerId = owner.id
  ownerCookie = await loginCookie(app, owner.email)
  const vault = await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie: ownerCookie }, body: { name: 'History events' } })
  vaultId = field(vault.json(), 'id')
  const minted = await app.inject({
    method: 'POST',
    url: '/api/mcp-connections',
    headers: { cookie: ownerCookie },
    body: { name: 'history-events-agent', scope: 'account' },
  })
  agent = new Client({ name: 'history-events-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${field(minted.json(), 'token')}` } },
    }),
  )
}, 60_000)

afterAll(async () => {
  await agent?.close()
  await app.close()
})

describe('delete and restore are history events', () => {
  it('records a delete by the author of the last edit, and the restore, in note_history', async () => {
    const note = await agentNote()
    await must('edit_note', { path: note.path, body: 'Second body.' })
    await must('delete_note', { path: note.path })
    await must('restore_note', { noteId: note.id })

    const rows = await agentHistory(note.path)
    expect(rows.map((r) => r.action)).toEqual(['restore', 'delete', 'update', 'create'])
    for (const row of rows) expect(row.actorType).toBe('mcp')
    expect(rows[0]!.actorId).toBe(rows[1]!.actorId)
  })

  it('attributes a restore to the person who restored, after an agent deleted', async () => {
    const note = await agentNote()
    await must('delete_note', { path: note.path })
    expect((await rest('POST', `/trash/${note.id}/restore`)).statusCode).toBe(200)

    const rows = await restHistory(note.path)
    expect(rows.map((r) => [r.action, r.actorType])).toEqual([
      ['restore', 'user'],
      ['delete', 'mcp'],
      ['create', 'mcp'],
    ])
    expect(rows[0]!.actorId).toBe(ownerId)
  })

  it('records every delete and restore of a note deleted twice', async () => {
    const note = await agentNote()
    for (let i = 0; i < 2; i++) {
      await must('delete_note', { path: note.path })
      await must('restore_note', { noteId: note.id })
    }
    expect((await agentHistory(note.path)).map((r) => r.action)).toEqual(['restore', 'delete', 'restore', 'delete', 'create'])
  })
})

describe('rename is a history event', () => {
  it('records the old and the new path, over MCP and REST', async () => {
    const note = await agentNote()
    const moved = await must<{ path: string }>('rename_note', { from: note.path, toName: `${note.path.split('/')[1]}-moved` })
    expect(moved.path).toBe(`${note.path}-moved`)

    const [renamed, created] = await agentHistory(moved.path)
    expect(renamed).toMatchObject({ action: 'rename', actorType: 'mcp', fromPath: note.path, toPath: moved.path })
    expect(created).toMatchObject({ action: 'create' })

    const res = await rest('POST', '/notes-rename', { from: moved.path, to: 'final-name' })
    expect(res.statusCode).toBe(200)
    const rows = await restHistory('docs/final-name')
    expect(rows[0]).toMatchObject({ action: 'rename', actorType: 'user', actorId: ownerId, fromPath: moved.path, toPath: 'docs/final-name' })
    expect(rows[1]).toMatchObject({ action: 'rename', fromPath: note.path, toPath: moved.path })
  })
})

describe('revert is its own row', () => {
  it('adds a revert row pointing at the source, and never relabels the newest row', async () => {
    const note = await agentNote('Original body.')
    await must('edit_note', { path: note.path, body: 'Edited body.' })
    const before = await agentHistory(note.path)
    expect(before.map((r) => r.action)).toEqual(['update', 'create'])
    const [edit, create] = before

    // Reverting to the newest revision repeats the note's state from the same agent.
    await must('revert_note', { path: note.path, revisionId: edit!.id })
    const afterRepeat = await agentHistory(note.path)
    expect(afterRepeat[0]).toMatchObject({ action: 'revert', actorType: 'mcp', sourceRevisionId: edit!.id })
    expect(afterRepeat[0]!.id).not.toBe(edit!.id)
    expect(afterRepeat.slice(1).map((r) => [r.id, r.action])).toEqual([
      [edit!.id, 'update'],
      [create!.id, 'create'],
    ])

    await must('revert_note', { path: note.path, revisionId: create!.id })
    const afterRevert = await agentHistory(note.path)
    const newest = afterRevert[0]!
    expect(newest).toMatchObject({ action: 'revert', sourceRevisionId: create!.id })
    // Rows from before the revert keep the action they were recorded with.
    const earlier = new Map(afterRepeat.map((r) => [r.id, r.action]))
    for (const row of afterRevert.slice(1)) {
      if (earlier.has(row.id)) expect(row.action).toBe(earlier.get(row.id))
      else expect(row.action).not.toBe('revert')
    }
    expect(afterRevert.filter((r) => r.action === 'revert')).toHaveLength(2)

    const revision = await must<{ body: string; sourceRevisionId?: string }>('get_revision', { revisionId: newest.id })
    expect(revision.body).toBe('Original body.')
    expect(revision.sourceRevisionId).toBe(create!.id)
    expect((await must<{ body: string }>('read_note', { path: note.path })).body).toBe('Original body.')
  })

  it('records a revert through REST as the person, with its source', async () => {
    const note = await agentNote('REST original.')
    await must('edit_note', { path: note.path, body: 'REST edited.' })
    const [, create] = await restHistory(note.path)
    expect((await rest('POST', `/revert/${note.path}`, { revisionId: create!.id })).statusCode).toBe(200)

    const rows = await restHistory(note.path)
    expect(rows[0]).toMatchObject({ action: 'revert', actorType: 'user', actorId: ownerId, sourceRevisionId: create!.id })
    expect(rows.filter((r) => r.action === 'revert')).toHaveLength(1)
    const detail = await rest('GET', `/revisions/${rows[0]!.id}`)
    expect(detail.json()).toMatchObject({ action: 'revert', sourceRevisionId: create!.id, body: 'REST original.' })
  })

  it('compares a later write with the write before the revert, not with the revert row', async () => {
    const note = await agentNote('Baseline original.')
    await must('edit_note', { path: note.path, body: 'Baseline edited.' })
    const [, create] = await agentHistory(note.path)
    await must('revert_note', { path: note.path, revisionId: create!.id })
    // The same agent writes the reverted state: the newest write it repeats
    // is `Baseline edited.`, so it is a new revision, not a repeat of the event.
    await must('edit_note', { path: note.path, body: 'Baseline original.' })
    const rows = await agentHistory(note.path)
    expect(rows.map((r) => r.action)).toEqual(['update', 'revert', 'update', 'create'])
    expect(rows[0]).toMatchObject({ actorType: 'mcp' })
  })
})
