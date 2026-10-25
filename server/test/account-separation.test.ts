// Two accounts, A and B (#552). A owns private vaults, a repository, notes,
// shares, perspectives, a team and a notification; B owns its own. Then:
//   listings  every surface that lists or searches across B's account (MCP
//             and REST: search, graph, find_symbols, related-note edges,
//             backlinks, notifications, lookup_user, perspectives, vaults,
//             repositories, teams) answers B and names nothing of A's;
//   probes    every MCP tool, REST route and prompt that takes an id, called
//             by B with one of A's ids, answers exactly like the same call
//             with an id that does not exist: no existence oracle.
// A's notes and B's note share their wording, and a semantic edge joins them
// (inserted by hand: the neighbour lookup no longer stores one across vaults,
// #461, but the reads must not depend on that), so the related-note surfaces
// have something to leak.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Prompt, Tool } from '@modelcontextprotocol/sdk/types.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { semanticEdges } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { notify } from '../src/notifications/notify.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>

const MARK_A = 'SEPALPHAPRIVATEMARK'
const MARK_B = 'SEPBRAVOOWNMARK'
const SYMBOL_A = 'sepAlphaPrivateSymbol'
const SHARED = 'orbital rendezvous checklist'
const PATH = { A: 'docs/secret-plan', B: 'docs/shared-name' }
const FILE = { A: 'src/a-only.ts', B: 'src/b-only.ts' }
/** Arguments that address a container: probed with A's container. */
const CONTAINER_KEYS = ['vaultId', 'repositoryId'] as const
/** Arguments that address an object inside a container: probed from B's own container. */
const OBJECT_KEYS = ['noteId', 'revisionId', 'shareId', 'notificationId', 'teamId', 'id'] as const
/** A call the SDK refused for its arguments (#439: the error envelope wraps it), before any id was looked up. */
const ARGS_REJECTED = /^\{"error":\{"code":"INVALID_ARGUMENT","message":"Invalid arguments for tool /
/** The not-found answer, byte for byte, for an id B cannot reach and for one that does not exist (#439, ADR-004 §2.7). */
const NOT_FOUND = '{"error":{"code":"NOT_FOUND","message":"not found","retryable":false}}'

let seq = 0
const next = () => `${Date.now().toString(36)}${(seq++).toString(36)}`

let app: FastifyInstance
let baseUrl: string
const clients: Client[] = []
let acctA: Client
let acctB: Client
let cookieA: string
let cookieB: string

interface Fixtures {
  a: { id: string; email: string; connectionId: string }
  c: { id: string; email: string }
  deactivatedEmail: string
  VA: string
  RA: string
  VB: string
  RB: string
  noteA: string
  noteB: string
  /** A's object ids per object argument (shareId split by container kind). */
  objects: {
    noteId: string[]
    revisionId: string[]
    vaultShareId: string[]
    repositoryShareId: string[]
    notificationId: string[]
    teamId: string[]
    id: string[]
  }
  /** Every string that would show one of A's private things. */
  markers: Record<string, string>
}
let fx: Fixtures

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'separation-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  try {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as Array<{ type: string; text?: string }>
    return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
  } catch (err) {
    return { isError: true, text: String(err) }
  }
}

/** prompts/get as text: the result as JSON, or the error a refused prompt throws. */
async function promptText(client: Client, name: string, args: Record<string, string>): Promise<string> {
  resetRateLimits()
  try {
    return JSON.stringify(await client.getPrompt({ name, arguments: args }))
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function must<T>(client: Client, name: string, args: Args): Promise<T> {
  const r = await call(client, name, args)
  if (r.isError) throw new Error(`${name} failed: ${r.text}`)
  return JSON.parse(r.text) as T
}

async function rest(cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, body?: Args) {
  const res = await app.inject({ method, url, headers: { cookie }, ...(body ? { body } : {}) })
  return { status: res.statusCode, text: res.body }
}

async function mint(cookie: string): Promise<{ id: string; token: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp-connections',
    headers: { cookie },
    body: { name: 'separation', scope: 'account' },
  })
  return res.json()
}

async function agentPushRepo(cookie: string, name: string, path: string, content: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/repositories',
    headers: { cookie },
    body: { name, ingestionMethod: 'agent_push' },
  })
  const created: { id: string } = res.json()
  await syncRepositoryFiles(created.id, [{ path, content }], [path])
  return created.id
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  // A is an instance admin so it can own a global perspective too.
  const a = await createActiveUser({ role: 'admin' })
  const b = await createActiveUser()
  const c = await createActiveUser()
  const deactivated = await createActiveUser({ status: 'deactivated' })
  cookieA = await loginCookie(app, a.email)
  cookieB = await loginCookie(app, b.email)
  const tokenA = await mint(cookieA)
  acctA = await mcpClient(tokenA.token)
  acctB = await mcpClient((await mint(cookieB)).token)

  // ---- A's private things
  const VA = (await must<{ id: string }>(acctA, 'create_vault', { name: `sep-alpha ${MARK_A}` })).id
  const noteA = (
    await must<{ id: string }>(acctA, 'create_note', {
      vaultId: VA,
      type: 'docs',
      name: 'secret-plan',
      // Names A's file, so a prompt that searches by file path (explain_code_architecture) finds the note (#441: no unrelated hits).
      body: `${MARK_A} ${SHARED}. See [[${PATH.B}]] and ${FILE.A}.`,
    })
  ).id
  const projectA = (
    await must<{ id: string }>(acctA, 'create_note', { vaultId: VA, type: 'project', name: 'sepalpha', body: `${MARK_A} ${SHARED}` })
  ).id
  await must(acctA, 'create_note', { vaultId: VA, type: 'docs', name: 'a-trashed', body: MARK_A })
  await must(acctA, 'delete_note', { vaultId: VA, path: 'docs/a-trashed' })
  const { notes: trash } = await must<{ notes: Array<{ id: string; path: string }> }>(acctA, 'list_trash', { vaultId: VA })
  const { revisions } = await must<{ revisions: Array<{ id: string }> }>(acctA, 'note_history', { vaultId: VA, path: PATH.A })
  await must(acctA, 'share_vault', { vaultId: VA, granteeType: 'user', granteeId: c.id, permission: 'read' })
  const vaultShares = await must<Array<{ id: string }>>(acctA, 'list_vault_shares', { vaultId: VA })
  const vaultPerspective = await must<{ id: string }>(acctA, 'save_graph_perspective', { vaultId: VA, name: `sep ${MARK_A}` })
  const globalPerspective = await must<{ id: string }>(acctA, 'save_graph_perspective', { name: `sep global ${MARK_A}` })
  const team = await must<{ id: string }>(acctA, 'create_team', { name: `sep-team ${MARK_A}` })
  const RA = await agentPushRepo(cookieA, `sep-alpha-repo-${next()}`, FILE.A, `export function ${SYMBOL_A}() { return '${MARK_A} ${SHARED}' }`)
  await must(acctA, 'share_repository', { repositoryId: RA, granteeType: 'user', granteeId: c.id })
  const repoShares = await must<Array<{ id: string }>>(acctA, 'list_repository_shares', { repositoryId: RA })
  await notify({ recipientId: a.id, type: 'separation_probe', message: `${MARK_A} for A only` })
  const notificationsA = await must<Array<{ id: string; message: string }>>(acctA, 'list_notifications', {})
  const notificationA = notificationsA.find((n) => n.message.includes(MARK_A))!

  // ---- B's own things, worded like A's
  const VB = (await must<{ id: string }>(acctB, 'create_vault', { name: 'sep-bravo' })).id
  const noteB = (
    await must<{ id: string }>(acctB, 'create_note', { vaultId: VB, type: 'docs', name: 'shared-name', body: `${MARK_B} ${SHARED}` })
  ).id
  const RB = await agentPushRepo(cookieB, `sep-bravo-repo-${next()}`, FILE.B, `export function sepBravoSymbol() { return '${MARK_B}' }`)
  await flushExtraction()
  await flushEmbeddings()
  // A cross-account related-note edge, as the neighbour lookup stored before #461 (migration 0038 deletes those).
  await db
    .insert(semanticEdges)
    .values([
      { sourceType: 'note', sourceId: noteB, targetType: 'note', targetId: noteA, similarity: 0.99 },
      { sourceType: 'note', sourceId: noteA, targetType: 'note', targetId: noteB, similarity: 0.99 },
    ])
    .onConflictDoNothing()

  const objects = {
    noteId: [trash.find((t) => t.path === 'docs/a-trashed')!.id],
    revisionId: [revisions[0]!.id],
    vaultShareId: [vaultShares[0]!.id],
    repositoryShareId: [repoShares[0]!.id],
    notificationId: [notificationA.id],
    teamId: [team.id],
    id: [vaultPerspective.id, globalPerspective.id],
  }
  fx = {
    a: { id: a.id, email: a.email, connectionId: tokenA.id },
    c: { id: c.id, email: c.email },
    deactivatedEmail: deactivated.email,
    VA,
    RA,
    VB,
    RB,
    noteA,
    noteB,
    objects,
    markers: {
      [VA]: "A's vault id",
      [RA]: "A's repository id",
      [noteA]: "A's note id",
      [projectA]: "A's project note id",
      [MARK_A]: "A's note, vault, team or notification text",
      [SYMBOL_A]: "A's code symbol",
      [vaultPerspective.id]: "A's vault perspective",
      [globalPerspective.id]: "A's global perspective",
      [team.id]: "A's team",
      [notificationA.id]: "A's notification",
      [objects.noteId[0]!]: "A's trashed note",
      [objects.revisionId[0]!]: "A's revision",
      [objects.vaultShareId[0]!]: "A's vault share",
      [objects.repositoryShareId[0]!]: "A's repository share",
      [tokenA.id]: "A's MCP connection",
    },
  }
}, 60_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

function leaks(text: string): string[] {
  return Object.entries(fx.markers)
    .filter(([needle]) => text.includes(needle))
    .map(([, what]) => what)
}

/** A response with the probed id replaced, so A's id and a missing id compare equal when the answers match. */
function normalized(text: string, id: string): string {
  return text.replaceAll(id, '<ID>')
}

/** Arguments for `tool`: the overrides, then defaults for every required argument. */
function argsFor(tool: Tool, side: 'A' | 'B', overrides: Args): Args {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string; format?: string; enum?: unknown[] }>
  const required = new Set(tool.inputSchema.required ?? [])
  const repoTool = 'repositoryId' in props && !('vaultId' in props)
  const named: Args = {
    path: repoTool ? FILE[side] : PATH[side],
    from: PATH[side],
    source: PATH[side],
    target: PATH[side],
    query: SHARED,
    email: fx.c.email,
    granteeId: fx.c.id,
    userId: fx.c.id,
    name: `sep-probe-${next()}`,
    toName: `sep-renamed-${next()}`,
    type: 'docs',
    body: 'probe',
  }
  const args: Args = {}
  for (const [key, schema] of Object.entries(props)) {
    if (key in overrides) {
      if (overrides[key] !== undefined) args[key] = overrides[key]
      continue
    }
    if (!required.has(key)) continue
    if (key in named) args[key] = named[key]
    else if (schema.enum?.length) args[key] = schema.enum[0]
    else if (schema.type === 'number' || schema.type === 'integer') args[key] = 1
    // A second id argument (get_revision's revisionId beside a probed noteId): one that exists nowhere.
    else if (schema.format === 'uuid') args[key] = randomUUID()
    else if (schema.type === 'boolean') args[key] = false
    else if (schema.type === 'array') args[key] = []
    else if (schema.type === 'object') args[key] = {}
    else args[key] = 'probe'
  }
  return args
}

interface Probe {
  tool: string
  label: string
  key: string
  aId: string
  args: (id: string) => Args
}

/** B's probes for one tool: each id argument, set to one of A's ids, then to a missing id. */
function probesFor(tool: Tool): Probe[] {
  const props = tool.inputSchema.properties ?? {}
  const repoTool = 'repositoryId' in props && !('vaultId' in props)
  const probes: Probe[] = []
  for (const key of CONTAINER_KEYS) {
    if (!(key in props)) continue
    const other = key === 'vaultId' ? 'repositoryId' : 'vaultId'
    // Everything else in the call names A's things too: an existing path, A's objects.
    const objectArgs: Args = {}
    for (const k of OBJECT_KEYS) if (k in props) objectArgs[k] = objectIds(k, key === 'repositoryId')[0]
    const base = argsFor(tool, 'A', { ...objectArgs, [other]: undefined })
    probes.push({
      tool: tool.name,
      label: `${tool.name} ${key}`,
      key,
      aId: key === 'vaultId' ? fx.VA : fx.RA,
      args: (id) => ({ ...base, [key]: id }),
    })
  }
  for (const key of OBJECT_KEYS) {
    if (!(key in props)) continue
    // From B's own container: B names A's object through a vault or repository B owns.
    const own: Args = {}
    if ('vaultId' in props && !repoTool) own.vaultId = fx.VB
    if ('repositoryId' in props && repoTool) own.repositoryId = fx.RB
    if ('vaultId' in props && 'repositoryId' in props) own.repositoryId = undefined
    const base = argsFor(tool, 'B', own)
    objectIds(key, repoTool).forEach((aId, i) =>
      probes.push({ tool: tool.name, label: `${tool.name} ${key}#${i}`, key, aId, args: (id) => ({ ...base, [key]: id }) }),
    )
  }
  return probes
}

function objectIds(key: (typeof OBJECT_KEYS)[number], repoTool: boolean): string[] {
  if (key === 'shareId') return repoTool ? fx.objects.repositoryShareId : fx.objects.vaultShareId
  return fx.objects[key]
}

describe("account separation: B sees nothing of A's (#552)", () => {
  it("A's own views show A's things (the fixtures are real)", async () => {
    expect((await call(acctA, 'search', { query: SHARED, everywhere: true })).text).toContain(fx.noteA)
    expect((await call(acctA, 'find_symbols', { query: SYMBOL_A })).text).toContain(SYMBOL_A)
    expect((await call(acctA, 'graph', { vaultId: fx.VA, aggregate: 'none' })).text).toContain(fx.noteA)
    expect((await call(acctA, 'list_notifications', {})).text).toContain(MARK_A)
    expect((await call(acctA, 'list_graph_perspectives', {})).text).toContain(fx.objects.id[1]!)
    // The hand-inserted cross-account edge is stored: only the read side keeps it from B.
    const edges = await db.select().from(semanticEdges).where(eq(semanticEdges.sourceId, fx.noteB))
    expect(edges.map((e) => e.targetId)).toContain(fx.noteA)
  })

  it("B's listings, searches, graphs, related notes, notifications and perspectives name nothing of A's", async () => {
    const mcp: Array<[string, Args]> = [
      ['search', { query: SHARED, everywhere: true }],
      ['search', { query: MARK_A, everywhere: true }],
      ['search', { query: SHARED, vaultId: fx.VB }],
      ['search', { query: SYMBOL_A, repositoryId: fx.RB }],
      ['graph', { repositoryId: fx.RB, aggregate: 'none' }],
      ['graph', { vaultId: fx.VB, aggregate: 'none' }],
      // The local view reads neighbours in SQL (#426): the stored cross-account semantic edge from B's note stays out.
      ['graph', { vaultId: fx.VB, neighborsOf: PATH.B, depth: 3 }],
      ['find_symbols', { query: SYMBOL_A }],
      ['find_symbols', { query: SYMBOL_A, everywhere: true }],
      ['list_notifications', {}],
      ['list_graph_perspectives', {}],
      ['list_graph_perspectives', { vaultId: fx.VB }],
      ['list_vaults', {}],
      ['list_repositories', {}],
      ['list_teams', {}],
      ['browse_vault', { vaultId: fx.VB }],
      ['read_note', { vaultId: fx.VB, path: PATH.B }],
      ['lookup_user', { email: fx.a.email }],
    ]
    const routes = [
      `/api/search?q=${encodeURIComponent(SHARED)}`,
      `/api/search?q=${MARK_A}`,
      `/api/symbols/search?q=${SYMBOL_A}`,
      '/api/graph/merged',
      `/api/vaults/${fx.VB}/graph`,
      `/api/vaults/${fx.VB}/local-graph/${PATH.B}?depth=2`,
      `/api/vaults/${fx.VB}/backlinks/${PATH.B}`,
      '/api/notifications',
      '/api/graph/perspectives',
      `/api/graph/perspectives?vaultId=${fx.VB}`,
      '/api/vaults',
      '/api/repositories',
      '/api/teams',
    ]
    const failures: string[] = []
    for (const [tool, args] of mcp) {
      const r = await call(acctB, tool, args)
      const where = `MCP ${tool} ${JSON.stringify(args)}`
      if (r.isError) failures.push(`${where}: failed: ${r.text.slice(0, 160)}`)
      const found = leaks(r.text)
      if (found.length) failures.push(`${where}: shows ${found.join(', ')}`)
    }
    for (const url of routes) {
      const r = await rest(cookieB, 'GET', url)
      if (r.status !== 200) failures.push(`GET ${url}: HTTP ${r.status} ${r.text.slice(0, 160)}`)
      const found = leaks(r.text)
      if (found.length) failures.push(`GET ${url}: shows ${found.join(', ')}`)
    }
    expect(failures).toEqual([])

    // B's views are not empty: B's own note and its related-note neighbourhood are there.
    expect((await call(acctB, 'search', { query: SHARED, everywhere: true })).text).toContain(MARK_B)
    expect((await rest(cookieB, 'GET', `/api/vaults/${fx.VB}/local-graph/${PATH.B}?depth=2`)).text).toContain(fx.noteB)
  })

  it('lookup_user answers for any active account with its id and email only; inactive and unknown emails answer alike', async () => {
    // Sharing needs a user id, so lookup_user finds every active account by exact email (by design).
    expect(JSON.parse((await call(acctB, 'lookup_user', { email: fx.a.email })).text)).toEqual({ id: fx.a.id, email: fx.a.email })
    const inactive = await call(acctB, 'lookup_user', { email: fx.deactivatedEmail })
    const unknown = await call(acctB, 'lookup_user', { email: `nobody-${next()}@test.local` })
    expect(inactive).toEqual({ isError: true, text: '{"error":{"code":"NOT_FOUND","message":"user not found","retryable":false}}' })
    expect(unknown).toEqual(inactive)
  })

  it("A's vault answers B the exact not-found bytes of a missing vault, with no path of A's suggested (#439)", async () => {
    const typo = 'docs/secret-pln'
    for (const vaultId of [fx.VA, randomUUID()]) {
      for (const tool of ['read_note', 'export_note', 'note_history', 'delete_note']) {
        expect(await call(acctB, tool, { vaultId, path: typo }), `${tool} ${vaultId === fx.VA ? "A's vault" : 'a missing vault'}`).toEqual({
          isError: true,
          text: NOT_FOUND,
        })
      }
    }
    // A reads the vault, so A gets its own path suggested.
    const own = JSON.parse((await call(acctA, 'read_note', { vaultId: fx.VA, path: typo })).text) as { error: { suggestions?: string[] } }
    expect(own.error.suggestions).toEqual([PATH.A])
  })

  it("every MCP tool answers B the same for A's id as for an id that does not exist", async () => {
    const { tools } = await acctB.listTools()
    const probes = tools.flatMap(probesFor)
    // Every id-taking tool family is covered.
    expect(new Set(probes.map((p) => p.key))).toEqual(new Set([...CONTAINER_KEYS, ...OBJECT_KEYS]))
    const failures: string[] = []
    for (const p of probes) {
      const missing = randomUUID()
      const own = await call(acctB, p.tool, p.args(p.aId))
      const none = await call(acctB, p.tool, p.args(missing))
      if (ARGS_REJECTED.test(own.text) || ARGS_REJECTED.test(none.text)) {
        failures.push(`${p.label}: probe arguments rejected: ${none.text.slice(0, 200)}`)
        continue
      }
      const found = leaks(normalized(own.text, p.aId))
      if (found.length) failures.push(`${p.label}: shows ${found.join(', ')}: ${own.text.slice(0, 160)}`)
      if (!own.isError) failures.push(`${p.label}: succeeded on A's id: ${own.text.slice(0, 160)}`)
      if (own.isError !== none.isError || normalized(own.text, p.aId) !== normalized(none.text, missing)) {
        failures.push(`${p.label}: A's id answers "${own.text.slice(0, 120)}", a missing id "${none.text.slice(0, 120)}"`)
      }
    }
    expect(failures).toEqual([])
  }, 120_000)

  it("every REST route answers B the same for A's id as for an id that does not exist", async () => {
    const q = encodeURIComponent(SHARED)
    const probes: Array<[string, 'GET' | 'POST' | 'DELETE', (id: string) => string, string]> = [
      ['vault tree', 'GET', (id) => `/api/vaults/${id}/tree`, fx.VA],
      ['vault access', 'GET', (id) => `/api/vaults/${id}/access`, fx.VA],
      ['vault shares', 'GET', (id) => `/api/vaults/${id}/shares`, fx.VA],
      ['read note', 'GET', (id) => `/api/vaults/${id}/notes/${PATH.A}`, fx.VA],
      ['backlinks', 'GET', (id) => `/api/vaults/${id}/backlinks/${PATH.A}`, fx.VA],
      ['local graph', 'GET', (id) => `/api/vaults/${id}/local-graph/${PATH.A}?depth=2`, fx.VA],
      ['vault search', 'GET', (id) => `/api/vaults/${id}/search?q=${q}`, fx.VA],
      ['vault graph', 'GET', (id) => `/api/vaults/${id}/graph`, fx.VA],
      ['vault graph path', 'GET', (id) => `/api/vaults/${id}/graph/path?source=${PATH.A}&target=project/sepalpha`, fx.VA],
      ['perspectives of a vault', 'GET', (id) => `/api/graph/perspectives?vaultId=${id}`, fx.VA],
      ['repository files', 'GET', (id) => `/api/repositories/${id}/files`, fx.RA],
      ['repository access', 'GET', (id) => `/api/repositories/${id}/access`, fx.RA],
      ['repository shares', 'GET', (id) => `/api/repositories/${id}/shares`, fx.RA],
      ['repository drift', 'GET', (id) => `/api/repositories/${id}/drift`, fx.RA],
      ['repository symbols', 'GET', (id) => `/api/repositories/${id}/symbols/search?q=${SYMBOL_A}`, fx.RA],
      ['revoke MCP connection', 'POST', (id) => `/api/mcp-connections/${id}/revoke`, fx.a.connectionId],
      ['mark notification read', 'POST', (id) => `/api/notifications/${id}/read`, fx.objects.notificationId[0]!],
      ['delete vault perspective', 'DELETE', (id) => `/api/graph/perspectives/${id}`, fx.objects.id[0]!],
      ['delete global perspective', 'DELETE', (id) => `/api/graph/perspectives/${id}`, fx.objects.id[1]!],
    ]
    const failures: string[] = []
    for (const [label, method, url, aId] of probes) {
      const missing = randomUUID()
      const own = await rest(cookieB, method, url(aId))
      const none = await rest(cookieB, method, url(missing))
      const found = leaks(normalized(own.text, aId))
      if (found.length) failures.push(`${label}: shows ${found.join(', ')}`)
      if (own.status < 400) failures.push(`${label}: HTTP ${own.status} on A's id`)
      if (own.status !== none.status || normalized(own.text, aId) !== normalized(none.text, missing)) {
        failures.push(`${label}: A's id answers ${own.status} ${own.text.slice(0, 120)}, a missing id ${none.status} ${none.text.slice(0, 120)}`)
      }
    }
    expect(failures).toEqual([])
  })

  it("every prompt that takes a vault answers B the same for A's vault as for a missing one, without A's notes", async () => {
    const { prompts } = await acctB.listPrompts()
    const withVault = prompts.filter((p) => p.arguments?.some((a) => a.name === 'vaultId'))
    expect(withVault.length).toBeGreaterThan(0)
    const promptArgs = (p: Prompt, vaultId: string): Record<string, string> => {
      const byName: Record<string, string> = {
        projectName: 'sepalpha',
        specPath: PATH.A,
        sourceNode: PATH.A,
        targetNode: 'project/sepalpha',
        filePath: FILE.A,
      }
      const args: Record<string, string> = { vaultId }
      for (const a of p.arguments ?? []) if (a.required) args[a.name] = byName[a.name] ?? SHARED
      return args
    }
    // Prompts that copy note text: A's own call shows A's note, so B's call has something to leak.
    const hydrating = ['active_project_companion', 'prepare_task_context', 'test_gap_analysis', 'plan_feature_implementation', 'explain_code_architecture']
    const failures: string[] = []
    for (const p of withVault) {
      if (hydrating.includes(p.name)) {
        const control = await promptText(acctA, p.name, promptArgs(p, fx.VA))
        if (!control.includes(MARK_A)) failures.push(`${p.name}: A's own call does not show A's note (probe is vacuous)`)
      }
      resetRateLimits()
      const missing = randomUUID()
      const own = await promptText(acctB, p.name, promptArgs(p, fx.VA))
      const none = await promptText(acctB, p.name, promptArgs(p, missing))
      const found = leaks(normalized(own, fx.VA))
      if (found.length) failures.push(`${p.name}: shows ${found.join(', ')}`)
      if (normalized(own, fx.VA) !== normalized(none, missing)) failures.push(`${p.name}: A's vault and a missing vault answer differently`)
    }
    expect(failures).toEqual([])
  })
})
