// The access-control matrix (helpers/access-matrix.ts) on every read surface
// that can name a note or a file: an owner shares a vault and a repository
// with a second account; the owner and the shared account see the object,
// an unrelated account never does, and after the revoke the shared account
// is refused with nothing identifying in the answer. The usage report is
// the #1034 leak class: a report that lists a read by its note's path after
// the share that allowed the read is gone.
import { afterAll, beforeAll, describe, expect } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { sql } from '../src/db/client.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'
import { accessMatrix, mcpOutcome, restOutcome, type Actor, type MatrixFixture, type ReadOutcome } from './helpers/access-matrix.js'

type Args = Record<string, unknown>

const MARK = 'quokkamatrix'
const TARGET = `docs/${MARK}-target`
const SOURCE = `docs/${MARK}-source`
const SOURCE_BODY = `${MARK}source orbital checklist, see [[${TARGET}]].`
const FILE = `src/${MARK}-plan.ts`
const FILE_BODY = `export const ${MARK}Plan = 'launch window'\n`

interface Account {
  id: string
  cookie: string
  mcp: Client
}

let app: FastifyInstance
let baseUrl: string
const clients: Client[] = []
const actors = {} as Record<Actor, Account>
let vaultId: string
let repositoryId: string
let sourceId: string
let fileId: string

async function rest(actor: Actor, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: Args) {
  return app.inject({ method, url, headers: { cookie: actors[actor].cookie }, ...(body ? { body } : {}) })
}

async function must(actor: Actor, method: 'POST' | 'PUT' | 'DELETE', url: string, body?: Args): Promise<Record<string, unknown>> {
  const res = await rest(actor, method, url, body)
  if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`)
  return res.json()
}

async function call(actor: Actor, name: string, args: Args): Promise<ReadOutcome> {
  resetRateLimits()
  return mcpOutcome(await actors[actor].mcp.callTool({ name, arguments: args }))
}

async function account(role: 'admin' | 'member', name: string): Promise<Account> {
  const user = await createActiveUser({ role })
  const cookie = await loginCookie(app, user.email)
  const minted = await app.inject({
    method: 'POST',
    url: '/api/mcp-connections',
    headers: { cookie },
    body: { name: `matrix-${name}`, scope: 'account', access: 'admin', profile: 'admin' },
  })
  const token = (minted.json() as { token: string }).token
  const mcp = new Client({ name: 'access-matrix-test', version: '0.0.0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(mcp)
  return { id: user.id, cookie, mcp }
}

/** Shares the vault and the repository with the shared account; the fixture's `revoke` takes both away. */
async function shareBoth(identifiers: string[], kind?: MatrixFixture['kind']): Promise<MatrixFixture> {
  const vaultShare = await must('owner', 'POST', `/api/vaults/${vaultId}/shares`, { granteeType: 'user', granteeId: actors.shared.id, permission: 'read' })
  const repoShare = await must('owner', 'POST', `/api/repositories/${repositoryId}/shares`, { granteeType: 'user', granteeId: actors.shared.id })
  return {
    identifiers,
    kind,
    revoke: async () => {
      await must('owner', 'DELETE', `/api/vaults/${vaultId}/shares/${vaultShare.id as string}`)
      await must('owner', 'DELETE', `/api/repositories/${repositoryId}/shares/${repoShare.id as string}`)
    },
  }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  // The owner is an instance admin: only one can turn the usage report on.
  actors.owner = await account('admin', 'owner')
  actors.shared = await account('member', 'shared')
  actors.unrelated = await account('member', 'unrelated')

  vaultId = (await must('owner', 'POST', '/api/vaults', { name: `matrix ${MARK}` })).id as string
  await must('owner', 'POST', `/api/vaults/${vaultId}/notes`, { type: 'docs', name: `${MARK}-target`, body: 'the target note' })
  sourceId = (await must('owner', 'POST', `/api/vaults/${vaultId}/notes`, { type: 'docs', name: `${MARK}-source`, body: SOURCE_BODY })).id as string
  repositoryId = (await must('owner', 'POST', '/api/repositories', { name: `matrix-${MARK}`, ingestionMethod: 'agent_push' })).id as string
  await syncRepositoryFiles(repositoryId, [{ path: FILE, content: FILE_BODY }], [FILE])
  await flushExtraction()
  await flushEmbeddings()
  const file = await rest('owner', 'GET', `/api/repositories/${repositoryId}/files/content?path=${encodeURIComponent(FILE)}`)
  fileId = (file.json() as { id: string }).id
  const on = await rest('owner', 'PUT', '/api/usage/settings', { enabled: true })
  expect(on.statusCode, on.body).toBe(200)
}, 60_000)

afterAll(async () => {
  if (actors.owner) {
    await rest('owner', 'PUT', '/api/usage/settings', { enabled: false })
    // usage-report.test.ts counts the instance's rows: the report writes the queued calls, then this file's rows go.
    await rest('owner', 'GET', '/api/usage/report')
    const accountIds = Object.values(actors).map((a) => a.id)
    await sql`DELETE FROM usage_events WHERE account_id = ANY(${accountIds}::uuid[])`
    await sql`DELETE FROM usage_daily WHERE account_id = ANY(${accountIds}::uuid[])`
  }
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('read surfaces (#552, #1034)', () => {
  accessMatrix('MCP read_note', {
    setup: () => shareBoth([SOURCE, `${MARK}source`]),
    read: (actor) => call(actor, 'read_note', { vaultId, path: SOURCE }),
  })
  accessMatrix('REST GET /api/vaults/:id/notes/*', {
    setup: () => shareBoth([sourceId, SOURCE, `${MARK}source`]),
    read: async (actor) => restOutcome(await rest(actor, 'GET', `/api/vaults/${vaultId}/notes/${SOURCE}`)),
  })

  accessMatrix('MCP read_file', {
    setup: () => shareBoth([FILE, `${MARK}Plan`]),
    read: (actor) => call(actor, 'read_file', { repositoryId, path: FILE }),
  })
  accessMatrix('REST GET /api/repositories/:id/files/content', {
    setup: () => shareBoth([fileId, FILE, `${MARK}Plan`]),
    read: async (actor) => restOutcome(await rest(actor, 'GET', `/api/repositories/${repositoryId}/files/content?path=${encodeURIComponent(FILE)}`)),
  })

  accessMatrix('MCP search in a vault', {
    setup: () => shareBoth([sourceId, SOURCE]),
    read: (actor) => call(actor, 'search', { vaultId, query: `${MARK}source` }),
  })
  accessMatrix('MCP search everywhere', {
    setup: () => shareBoth([sourceId, SOURCE], 'listing'),
    read: (actor) => call(actor, 'search', { everywhere: true, query: `${MARK}source` }),
  })
  accessMatrix('REST GET /api/search (everywhere)', {
    setup: () => shareBoth([sourceId, SOURCE], 'listing'),
    read: async (actor) => restOutcome(await rest(actor, 'GET', `/api/search?q=${MARK}source`)),
  })

  accessMatrix('REST GET /api/vaults/:id/backlinks/* (who links to the target)', {
    setup: () => shareBoth([sourceId, SOURCE]),
    read: async (actor) => restOutcome(await rest(actor, 'GET', `/api/vaults/${vaultId}/backlinks/${TARGET}`)),
  })
  accessMatrix('MCP graph neighborsOf the target (nodes and backlinks)', {
    setup: () => shareBoth([SOURCE]),
    read: (actor) => call(actor, 'graph', { vaultId, neighborsOf: TARGET, edgeTypes: ['extracted'] }),
  })
  accessMatrix('MCP graph of a vault, every node', {
    setup: () => shareBoth([SOURCE, TARGET]),
    read: (actor) => call(actor, 'graph', { vaultId, aggregate: 'none' }),
  })
  accessMatrix('REST GET /api/vaults/:id/local-graph/*', {
    setup: () => shareBoth([sourceId, SOURCE]),
    read: async (actor) => restOutcome(await rest(actor, 'GET', `/api/vaults/${vaultId}/local-graph/${TARGET}?depth=1`)),
  })

  // The usage report (#678, #1034): a read, then a client-reported fallback,
  // and the report lists the notes read just before it by id and path. The
  // read is this actor's own MCP call; the report must list it only while
  // the note is still reachable.
  const readThenReport = async (actor: Actor, report: () => Promise<ReadOutcome>): Promise<ReadOutcome> => {
    await call(actor, 'read_note', { vaultId, path: SOURCE })
    resetRateLimits()
    await actors[actor].mcp.notification({ method: 'notifications/elara/client_event', params: { event: 'local_fallback' } })
    return report()
  }
  accessMatrix('REST GET /api/usage/report', {
    setup: () => shareBoth([sourceId, SOURCE], 'listing'),
    read: (actor) => readThenReport(actor, async () => restOutcome(await rest(actor, 'GET', '/api/usage/report'))),
  })
  accessMatrix('MCP usage_report', {
    setup: () => shareBoth([sourceId, SOURCE], 'listing'),
    read: (actor) => readThenReport(actor, () => call(actor, 'usage_report', {})),
  })
})
