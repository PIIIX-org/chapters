// #931: the REST note write routes answered the whole note row, `embedding`
// (384 floats), `deletedAt`, `seq` and the migration stamps included; #427
// had stripped them from MCP write replies only. Every REST write answers the
// note's documented fields and `rev`, as GET does.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { sql } from '../src/db/client.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Reply = Record<string, unknown>

const NOTE_FIELDS = ['id', 'vaultId', 'type', 'name', 'path', 'frontmatter', 'body', 'createdAt', 'updatedAt', 'rev']
const PUT_BASE_REV_EXTRAS = ['status', 'concurrentChanges', 'baseRev']
const ALLOWED = new Set([...NOTE_FIELDS, ...PUT_BASE_REV_EXTRAS])
const INTERNAL = ['embedding', 'deletedAt', 'frontmatterSrc', 'fts', 'seq', 'storeMigratedAt', 'collabMigratedAt']
/** A small note's whole reply: far below one 384-float embedding (~7 kB of JSON). */
const MAX_REPLY_CHARS = 1500

let app: FastifyInstance
let cookie: string
let vaultId: string

async function rest(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: Reply): Promise<{ reply: Reply; text: string }> {
  const res = await app.inject({ method, url: `/api/vaults/${vaultId}${url}`, headers: { cookie }, ...(body ? { body } : {}) })
  if (res.statusCode !== 200) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`)
  return { reply: res.json<Reply>(), text: res.body }
}

function expectLean(route: string, { reply, text }: { reply: Reply; text: string }): void {
  for (const key of INTERNAL) expect(reply, `${route} answers ${key}`).not.toHaveProperty(key)
  expect(Object.keys(reply).filter((key) => !ALLOWED.has(key)), `${route} answers unlisted fields`).toEqual([])
  expect(text.length, `${route} reply size`).toBeLessThan(MAX_REPLY_CHARS)
}

/** Gives the note an embedding, as the save-time embedding job would. */
async function embed(path: string): Promise<void> {
  const vector = `[${Array.from({ length: 384 }, (_, i) => (i % 7) / 7 + 0.123456).join(',')}]`
  await sql`UPDATE notes SET embedding = ${vector}::vector WHERE vault_id = ${vaultId} AND path = ${path}`
}

beforeAll(async () => {
  app = await buildApp()
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'REST reply fields' } })).json<{ id: string }>().id
})

afterAll(async () => {
  await app.close()
})

describe('REST note write replies carry no embedding or internal columns (#931)', () => {
  it('create, update, rename, revert, restore and read answer only the documented fields', async () => {
    const created = await rest('POST', '/notes', { type: 'notes', name: 'lean', body: 'One.\n' })
    expectLean('POST /notes', created)
    const path = String(created.reply.path)
    expect(created.reply).toMatchObject({ path, type: 'notes', name: 'lean', body: 'One.\n', rev: 1 })
    await embed(path)

    const updated = await rest('PUT', `/notes/${path}`, { body: 'One.\nTwo.\n' })
    expectLean('PUT /notes', updated)
    expect(updated.reply).toMatchObject({ path, body: 'One.\nTwo.\n', rev: 2 })
    await embed(path)

    const merged = await rest('PUT', `/notes/${path}`, { body: 'One.\nTwo.\nThree.\n', baseRev: 2 })
    expectLean('PUT /notes baseRev', merged)
    expect(merged.reply).toMatchObject({ status: 'applied', baseRev: 2 })
    await embed(path)

    const read = await rest('GET', `/notes/${path}`)
    expectLean('GET /notes', read)

    const renamed = await rest('POST', '/notes-rename', { from: path, to: 'leaner' })
    expectLean('POST /notes-rename', renamed)
    const moved = String(renamed.reply.path)
    expect(moved).toBe('notes/leaner')
    await embed(moved)

    const history = (await rest('GET', `/history/${moved}?limit=200`)).reply as unknown as Array<{ id: string; action: string }>
    const first = history[history.length - 1]
    const reverted = await rest('POST', `/revert/${moved}`, { revisionId: first.id })
    expectLean('POST /revert', reverted)
    expect(reverted.reply).toMatchObject({ path: moved, body: 'One.\n' })
    await embed(moved)

    await rest('DELETE', `/notes/${moved}`)
    const restored = await rest('POST', `/trash/${String(created.reply.id)}/restore`)
    expectLean('POST /trash/:noteId/restore', restored)
    expect(restored.reply).toMatchObject({ id: created.reply.id, path: moved })
  })
})
