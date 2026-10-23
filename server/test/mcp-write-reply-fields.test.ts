// #427: every MCP write answered the whole note row, `embedding` (384 floats,
// 93% of an edit_note reply) and other internal columns included. A write
// answers only the documented note fields and the write result fields, and a
// stored idempotency answer recorded in the old shape is stripped on replay.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { sql } from '../src/db/client.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Answer = Record<string, unknown>

const NOTE_FIELDS = ['id', 'vaultId', 'type', 'name', 'path', 'frontmatter', 'body', 'createdAt', 'updatedAt']
const WRITE_FIELDS = ['rev', 'status', 'diff_stats', 'concurrent_changes', 'indexed', 'dry_run', 'replayed']
const TOOL_EXTRAS = ['created', 'baseRev', 'trashed']
const ALLOWED = new Set([...NOTE_FIELDS, ...WRITE_FIELDS, ...TOOL_EXTRAS])
const INTERNAL = ['embedding', 'deletedAt', 'frontmatterSrc', 'frontmatter_src', 'fts', 'seq', 'storeMigratedAt', 'collabMigratedAt']
/** A small note's whole answer: far below one 384-float embedding (~7 kB of JSON). */
const MAX_REPLY_CHARS = 1500

let app: FastifyInstance
let collab: CollabRelay
let cookie: string
let vaultId: string
let mcp: Client

async function call(name: string, args: Record<string, unknown>): Promise<{ answer: Answer; text: string }> {
  resetRateLimits()
  const result = await mcp.callTool({ name, arguments: { vaultId, ...args } })
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
  if (result.isError) throw new Error(`${name} failed: ${text}`)
  return { answer: JSON.parse(text) as Answer, text }
}

function expectLean(tool: string, { answer, text }: { answer: Answer; text: string }): void {
  for (const key of INTERNAL) expect(answer, `${tool} answers ${key}`).not.toHaveProperty(key)
  expect(Object.keys(answer).filter((key) => !ALLOWED.has(key)), `${tool} answers unlisted fields`).toEqual([])
  expect(text.length, `${tool} answer size`).toBeLessThan(MAX_REPLY_CHARS)
}

/** Gives the note an embedding, as the save-time embedding job would. */
async function embed(path: string): Promise<void> {
  const vector = `[${Array.from({ length: 384 }, (_, i) => (i % 7) / 7 + 0.123456).join(',')}]`
  await sql`UPDATE notes SET embedding = ${vector}::vector WHERE vault_id = ${vaultId} AND path = ${path} AND deleted_at IS NULL`
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Reply fields' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'reply-fields', scope: 'account' } })
  mcp = new Client({ name: 'reply-fields-test', version: '0.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
})

afterAll(async () => {
  await mcp.close()
  await collab.destroy()
  await app.close()
})

describe('write replies carry no embedding or internal columns (#427)', () => {
  it('create, edit, append, upsert, rename, revert, delete and restore answer only the documented fields', async () => {
    const path = 'notes/lean'
    const created = await call('create_note', { path, frontmatter: { title: 'Lean' }, body: 'One.\n' })
    expectLean('create_note', created)
    expect(created.answer).toMatchObject({ path, body: 'One.\n', frontmatter: { title: 'Lean' }, rev: 1, status: 'applied' })
    await embed(path)

    expectLean('edit_note', await call('edit_note', { path, body: 'One.\nTwo.\n' }))
    await embed(path)
    expectLean('edit_note dry_run', await call('edit_note', { path, body: 'Three.\n', dry_run: true }))
    expectLean('append_note', await call('append_note', { path, text: 'Three.\n' }))
    await embed(path)
    expectLean('upsert_note', await call('upsert_note', { path, body: 'Upserted.\n' }))
    expectLean('upsert_note create', await call('upsert_note', { path: 'notes/other', body: 'Other.\n' }))
    await embed(path)

    const renamed = await call('rename_note', { from: path, toName: 'leaner' })
    expectLean('rename_note', renamed)
    const newPath = String(renamed.answer.path)
    await embed(newPath)

    const [revision] = await sql<Array<{ id: string }>>`
      SELECT r.id FROM note_revisions r JOIN notes n ON n.id = r.note_id
      WHERE n.vault_id = ${vaultId} AND n.path = ${newPath} ORDER BY r.created_at, r.id LIMIT 1`
    expectLean('revert_note', await call('revert_note', { path: newPath, revisionId: revision!.id }))
    await embed(newPath)

    const deleted = await call('delete_note', { path: newPath })
    expectLean('delete_note', deleted)
    expectLean('restore_note', await call('restore_note', { noteId: String(deleted.answer.id) }))
  })

  it('a stored answer recorded in the old shape is stripped when replayed', async () => {
    const path = 'notes/replayed'
    await call('create_note', { path, body: 'Body.\n' })
    const args = { path, body: 'Edited.\n', idempotency_key: 'reply-fields-replay' }
    expectLean('edit_note keyed', await call('edit_note', args))
    // An answer recorded before #427 carried the whole row.
    await sql`
      UPDATE write_idempotency
      SET result = result || jsonb_build_object('embedding', array_fill(0.5::float8, ARRAY[384]), 'deletedAt', null, 'frontmatterSrc', '{}'::jsonb)
      WHERE key = 'reply-fields-replay'`
    const replayed = await call('edit_note', args)
    expect(replayed.answer.replayed).toBe(true)
    expectLean('edit_note replayed', replayed)
  })
})
