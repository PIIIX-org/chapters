// #478: agents appended to a shared note by read_note, then edit_note with
// the old body plus their line. Two agents that read the same body overwrote
// each other: the lab lost 50–92% of acknowledged appends, a real two-agent
// log 1 of 11. `append_note` appends to the live text under the note's write
// lock, creating the note when asked; `upsert_note` creates or replaces a
// note with no window between the exists-check and the create.
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, asc, eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { noteRevisions } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { getLiveNote } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

type Args = Record<string, unknown>
interface Agent {
  client: Client
  id: string
}

const N = 20

let app: FastifyInstance
let collab: CollabRelay
let baseUrl: string
let ownerCookie: string
let ownerToken: string
let vaultId: string
const agents: Agent[] = []
const providers: HocuspocusProvider[] = []

async function connect(name: string): Promise<Agent> {
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie: ownerCookie }, body: { name, scope: 'account' } })
  if (minted.statusCode !== 200) throw new Error(`mint failed: ${minted.statusCode} ${minted.body}`)
  const { token, id } = minted.json<{ token: string; id: string }>()
  const client = new Client({ name: `${name}-test`, version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  return { client, id }
}

async function call(agent: Agent, name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await agent.client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function must<T>(agent: Agent, name: string, args: Args): Promise<T> {
  const r = await call(agent, name, args)
  if (r.isError) throw new Error(`${name} failed: ${r.text}`)
  return JSON.parse(r.text) as T
}

/** Polls a condition the relay reaches on its own (a WebSocket round trip); real time, as in the other relay tests. */
async function waitFor(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

/** The `created` flag of an append_note/upsert_note result. */
function created(r: { text: string }): boolean {
  const parsed: unknown = JSON.parse(r.text)
  return typeof parsed === 'object' && parsed !== null && 'created' in parsed && parsed.created === true
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

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

async function revisions(noteId: string) {
  return db.select().from(noteRevisions).where(eq(noteRevisions.noteId, noteId)).orderBy(asc(noteRevisions.ord))
}

async function creates(noteId: string) {
  return db.select().from(noteRevisions).where(and(eq(noteRevisions.noteId, noteId), eq(noteRevisions.action, 'create')))
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  ownerToken = await loginToken(app, owner.email)
  const vault = await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie: ownerCookie }, body: { name: 'Atomic append' } })
  vaultId = vault.json<{ id: string }>().id
  for (let i = 0; i < N; i++) agents.push(await connect(`appender-${i}`))
}, 60_000)

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  for (const { client } of agents) await client.close().catch(() => {})
  await collab.destroy()
  await app.close()
})

describe('append_note (#478)', () => {
  it(`${N} concurrent appends from separate MCP sessions to one note each land exactly once, attributed to their session`, async () => {
    const path = 'docs/shared-log'
    await must(agents[0]!, 'create_note', { vaultId, path, body: '# Log\n' })
    const line = (i: number) => `- entry from agent ${i} `
    const results = await Promise.all(agents.map((agent, i) => call(agent, 'append_note', { vaultId, path, text: line(i) })))
    expect(results.filter((r) => r.isError).map((r) => r.text)).toEqual([])

    const row = (await getLiveNote(vaultId, path))!
    for (let i = 0; i < N; i++) expect(occurrences(row.body, line(i)), `agent ${i} in ${row.body}`).toBe(1)
    expect(row.body.startsWith('# Log\n')).toBe(true)
    expect(row.body.split('\n').filter((l) => l.startsWith('- entry'))).toHaveLength(N)

    // Every append is its own revision, attributed to the session that sent it.
    const revs = await revisions(row.id)
    for (let i = 0; i < N; i++) {
      const mine = revs.filter((r) => r.actorType === 'mcp' && r.actorId === agents[i]!.id && r.action === 'update')
      expect(mine.some((r) => r.body.includes(line(i))), `revision for agent ${i}`).toBe(true)
    }
  }, 60_000)

  it('appends to the live text while a person has the note open, keeping their unsaved typing', async () => {
    const path = 'docs/open-log'
    const body = 'Intro.\n'
    await must(agents[0]!, 'create_note', { vaultId, path, body })
    const tab = open(path)
    const text = tab.document.getText('body')
    await waitFor(() => text.toString() === body)
    text.insert(0, 'TYPED ')
    await waitFor(() => (collab.hocuspocus.documents.get(`${vaultId}/${path}`)?.getText('body').toString() ?? '').includes('TYPED'))

    const results = await Promise.all(agents.slice(0, 5).map((agent, i) => call(agent, 'append_note', { vaultId, path, text: `line ${i}` })))
    expect(results.filter((r) => r.isError).map((r) => r.text)).toEqual([])
    const row = (await getLiveNote(vaultId, path))!
    expect(row.body.startsWith('TYPED Intro.\n')).toBe(true)
    for (let i = 0; i < 5; i++) expect(occurrences(row.body, `line ${i}\n`), row.body).toBe(1)
    await waitFor(() => text.toString() === row.body)
  })

  for (const n of [5, 10, 20]) {
    it(`createIfMissing: ${n} concurrent appends to a missing note create it once, every line lands, every other session keeps a restore point`, async () => {
      const path = `docs/new-log-${n}`
      const frontmatter = { title: 'New log', tags: ['log'] }
      const writers = agents.slice(0, n)
      const results = await Promise.all(
        writers.map((agent, i) => call(agent, 'append_note', { vaultId, path, text: `first ${i}`, createIfMissing: true, frontmatter })),
      )
      expect(results.filter((r) => r.isError).map((r) => r.text)).toEqual([])
      expect(results.filter(created)).toHaveLength(1)

      const row = (await getLiveNote(vaultId, path))!
      for (let i = 0; i < n; i++) expect(occurrences(row.body, `first ${i}\n`), row.body).toBe(1)
      expect(row.frontmatter).toMatchObject({ type: 'docs', title: 'New log', tags: ['log'] })
      expect(await creates(row.id)).toHaveLength(1)
      // Every call that did not create the note edited it, with a restore point of its session (#482).
      const points = (await revisions(row.id)).filter((r) => r.action === 'restore_point')
      const creator = results.findIndex(created)
      expect(points.map((r) => r.actorId).sort()).toEqual(writers.filter((_, i) => i !== creator).map((a) => a.id).sort())
    }, 60_000)
  }

  it('without createIfMissing a missing note is "not found" and nothing is created', async () => {
    const r = await call(agents[0]!, 'append_note', { vaultId, path: 'docs/absent-log', text: 'x' })
    expect(r).toEqual({ isError: true, text: 'Error: note not found' })
    expect(await getLiveNote(vaultId, 'docs/absent-log')).toBeNull()
  })

  it('frontmatter merges per key into an existing note; the size cap and the quarantine apply', async () => {
    const path = 'docs/guarded-log'
    const start = Array.from({ length: 40 }, (_, i) => `Distinct line ${i}: observation ${i * 37} about item ${i * 11 + 3}.`).join('\n') + '\n'
    await must(agents[0]!, 'create_note', { vaultId, path, frontmatter: { title: 'Guarded', status: 'draft' }, body: start })
    await must(agents[0]!, 'append_note', { vaultId, path, text: 'more', frontmatter: { status: 'active' } })
    let row = (await getLiveNote(vaultId, path))!
    expect(row.frontmatter).toMatchObject({ title: 'Guarded', status: 'active' })
    expect(row.body).toBe(`${start}more\n`)

    const doubled = await call(agents[0]!, 'append_note', { vaultId, path, text: start })
    expect(doubled.isError).toBe(true)
    expect(doubled.text).toMatch(/allowGrowth/)
    expect((await getLiveNote(vaultId, path))!.body).toBe(`${start}more\n`)
    await must(agents[0]!, 'append_note', { vaultId, path, text: start, allowGrowth: true })
    expect((await getLiveNote(vaultId, path))!.body).toBe(`${start}more\n${start}`)

    const nearPath = 'docs/near-cap-log'
    const near = `${'x'.repeat(config.noteMaxBytes - 10)}\n`
    await must(agents[0]!, 'create_note', { vaultId, path: nearPath, body: near })
    const over = await call(agents[0]!, 'append_note', { vaultId, path: nearPath, text: 'y'.repeat(100), allowGrowth: true })
    expect(over.isError).toBe(true)
    expect(over.text).toMatch(/limit is/)
    row = (await getLiveNote(vaultId, nearPath))!
    expect(row.body).toBe(near)
  })
})

describe('upsert_note (#478)', () => {
  it('two concurrent upserts of a missing note: one create, no error, the other replaces it', async () => {
    const path = 'docs/upserted'
    const [a, b] = await Promise.all([
      call(agents[0]!, 'upsert_note', { vaultId, path, body: 'from A\n' }),
      call(agents[1]!, 'upsert_note', { vaultId, path, body: 'from B\n' }),
    ])
    expect([a.isError, b.isError], `${a.text} ${b.text}`).toEqual([false, false])
    const madeIt = [a, b].map(created)
    expect(madeIt.filter(Boolean)).toHaveLength(1)

    const row = (await getLiveNote(vaultId, path))!
    expect(await creates(row.id)).toHaveLength(1)
    // The one that did not create replaced the body after the create.
    const second = madeIt[0] ? 'from B\n' : 'from A\n'
    expect(row.body).toBe(second)
  })

  it('an upsert racing create_note never fails: either create wins, the upsert replaces or creates', async () => {
    for (let round = 0; round < 5; round++) {
      const path = `docs/raced-${round}`
      const [made, upserted] = await Promise.all([
        call(agents[2]!, 'create_note', { vaultId, path, body: 'created\n' }),
        call(agents[3]!, 'upsert_note', { vaultId, path, body: 'upserted\n' }),
      ])
      expect(upserted.isError, upserted.text).toBe(false)
      if (made.isError) expect(made.text).toMatch(/already exists/)
      const row = (await getLiveNote(vaultId, path))!
      expect(await creates(row.id)).toHaveLength(1)
    }
  })

  it('replaces the body of an existing note, merges frontmatter per key, and keeps a restore point', async () => {
    const path = 'docs/upsert-existing'
    await must(agents[4]!, 'create_note', { vaultId, path, frontmatter: { title: 'Kept', status: 'draft' }, body: 'old body\n' })
    const r = await must<{ body: string; created: boolean }>(agents[5]!, 'upsert_note', { vaultId, path, body: 'new body\n', frontmatter: { status: 'stable' } })
    expect(r.created).toBe(false)
    const row = (await getLiveNote(vaultId, path))!
    expect(row.body).toBe('new body\n')
    expect(row.frontmatter).toMatchObject({ title: 'Kept', status: 'stable' })
    const revs = await revisions(row.id)
    expect(revs.some((rev) => rev.action === 'restore_point' && rev.actorId === agents[5]!.id && rev.body === 'old body\n')).toBe(true)
  })
})
