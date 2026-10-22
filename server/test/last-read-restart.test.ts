// #408, #476 (review of #864): the base of a whole edit_note `body` sent
// without `base_rev` is the `rev` of the connection's last read_note. Kept
// only in the server's memory, a restart between the agent's read and its
// edit forgot it, so the edit replaced the live text again and removed what
// a person wrote after the read. It is kept in Postgres (`note_reads`), per
// connection and note, for 24 hours; purging the note deletes its rows.
//
// Each "server" is a fresh module graph (vi.resetModules), so nothing held in
// a module survives from one to the next, as in a restarted process.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { createActiveUser, loginCookie } from './helpers.js'

const BODY = 'Para one.\n\nPara two.\n\nPara three.\n'

let app: FastifyInstance | null = null
let url = ''
let cookie = ''
let token = ''
let vaultId = ''
const sql = postgres(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!, { max: 1, onnotice: () => {} })

/** Starts a server from freshly loaded modules, after stopping the previous one. */
async function restart(): Promise<void> {
  await app?.close()
  vi.resetModules()
  // Dynamic on purpose: a fresh module graph is the restart this test is about.
  const { buildApp } = await import('../src/app.js')
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}

async function call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { vaultId, ...args } } }),
  })
  const body = (await res.json()) as { result?: { isError?: boolean; content: Array<{ text: string }> } }
  const text = body.result?.content.map((c) => c.text).join('') ?? JSON.stringify(body)
  if (!body.result || body.result.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text) as T
}

async function rest(method: 'PUT' | 'POST', path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${url}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

beforeAll(async () => {
  await restart()
  const owner = await createActiveUser()
  cookie = await loginCookie(app!, owner.email)
  const vault: { id: string } = await (await rest('POST', '/api/vaults', { name: 'Last read' })).json()
  vaultId = vault.id
  const minted: { token: string } = await (await rest('POST', '/api/mcp-connections', { name: 'last-read', scope: 'account' })).json()
  token = minted.token
})

afterAll(async () => {
  await app?.close()
  await sql.end()
})

describe("the connection's last read survives a server restart (#408, #476)", () => {
  it('a whole body sent after a restart still merges from the read: what a person wrote after it stays', async () => {
    const path = 'docs/read-then-restart'
    await call('create_note', { path, body: BODY })
    const read = await call<{ body: string; rev: number }>('read_note', { path })
    // A person changes the first paragraph after the agent's read.
    const person = BODY.replace('Para one.', 'Para one, by a person.')
    expect((await rest('PUT', `/api/vaults/${vaultId}/notes/${path}`, { body: person })).status).toBe(200)

    await restart()
    const edited = await call<{ status: string; baseRev: number; body: string }>('edit_note', {
      path,
      body: read.body.replace('Para three.', 'Para three, by the agent.'),
    })
    expect(edited).toMatchObject({ status: 'merged', baseRev: read.rev, body: person.replace('Para three.', 'Para three, by the agent.') })
  }, 30_000)

  it('keeps reads for 24 hours, and purging the note deletes its rows', async () => {
    const path = 'docs/read-pruned'
    const { id } = await call<{ id: string }>('create_note', { path, body: BODY })
    await call('read_note', { path })
    expect(await sql`SELECT 1 FROM note_reads WHERE note_id = ${id}`).toHaveLength(1)

    // A read older than 24 hours is pruned by the next read of any note, and is no base any more.
    await sql`UPDATE note_reads SET read_at = now() - interval '25 hours' WHERE note_id = ${id}`
    await call('create_note', { path: 'docs/read-other', body: BODY })
    await call('read_note', { path: 'docs/read-other' })
    expect(await sql`SELECT 1 FROM note_reads WHERE note_id = ${id}`).toHaveLength(0)

    await call('read_note', { path })
    await call('delete_note', { path })
    await call('purge_note', { noteId: id })
    expect(await sql`SELECT 1 FROM note_reads WHERE note_id = ${id}`).toHaveLength(0)
  }, 30_000)
})
