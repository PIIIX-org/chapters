// Who may save, list and delete graph perspectives (#550), over REST and MCP
// alike. A vault perspective needs edit access to its vault to be saved or
// deleted; a global perspective (no vault) is personal: listed and deletable
// only by its creator, with instance admins seeing every one in the list.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { graphPerspectives } from '../src/db/schema.js'
import { createActiveUser, loginCookie } from './helpers.js'

interface Perspective {
  id: string
  name: string
  vaultId: string | null
}

let app: FastifyInstance
let baseUrl: string
let vaultId: string
const cookie: Record<string, string> = {}
const userId: Record<string, string> = {}
const clients: Client[] = []
const mcp: Record<string, Client> = {}

type Who = 'creator' | 'otherAdmin' | 'editor' | 'reader' | 'member' | 'teamEditor' | 'teamReader'

function rest(who: Who, method: 'GET' | 'POST' | 'DELETE', url: string, body?: Record<string, unknown>) {
  return app.inject({ method, url, headers: { cookie: cookie[who]! }, ...(body === undefined ? {} : { body }) })
}

async function listRest(who: Who, query = ''): Promise<string[]> {
  const res = await rest(who, 'GET', `/api/graph/perspectives${query}`)
  expect(res.statusCode).toBe(200)
  return res.json<Perspective[]>().map((p) => p.id)
}

async function call(who: Who, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await mcp[who]!.callTool({ name, arguments: args })
  const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined
  const text = first && typeof first === 'object' && 'text' in first && typeof first.text === 'string' ? first.text : ''
  return { isError: Boolean(result.isError), text }
}

/** The perspective rows an MCP tool returned as JSON text. */
function perspectivesOf(text: string): Perspective[] {
  const parsed: unknown = JSON.parse(text)
  return Array.isArray(parsed) ? parsed.map(perspectiveOf) : [perspectiveOf(parsed)]
}

function perspectiveOf(value: unknown): Perspective {
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && 'name' in value && typeof value.name === 'string') {
    const vaultId = 'vaultId' in value && typeof value.vaultId === 'string' ? value.vaultId : null
    return { id: value.id, name: value.name, vaultId }
  }
  throw new Error(`not a perspective: ${JSON.stringify(value)}`)
}

async function listMcp(who: Who, args: Record<string, unknown> = {}): Promise<string[]> {
  const r = await call(who, 'list_graph_perspectives', args)
  expect(r.isError).toBe(false)
  return perspectivesOf(r.text).map((p) => p.id)
}

async function saveRest(who: Who, body: Record<string, unknown>): Promise<Perspective> {
  const res = await rest(who, 'POST', '/api/graph/perspectives', body)
  expect(res.statusCode).toBe(201)
  return res.json<Perspective>()
}

/** A perspective row saved earlier, e.g. while its creator still had edit access. */
async function insertPerspective(who: Who, name: string): Promise<string> {
  const [row] = await db
    .insert(graphPerspectives)
    .values({ name, vaultId, userId: userId[who]!, filters: {}, isShared: true })
    .returning()
  return row!.id
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  // Global perspectives can only be created by an instance admin, so the creator is one.
  const users = {
    creator: await createActiveUser({ role: 'admin' }),
    otherAdmin: await createActiveUser({ role: 'admin' }),
    editor: await createActiveUser(),
    reader: await createActiveUser(),
    member: await createActiveUser(),
    teamEditor: await createActiveUser(),
    teamReader: await createActiveUser(),
  }
  for (const [who, user] of Object.entries(users)) {
    cookie[who] = await loginCookie(app, user.email)
    userId[who] = user.id
  }

  vaultId = (await rest('creator', 'POST', '/api/vaults', { name: 'Perspective permissions' })).json<{ id: string }>().id
  for (const [who, permission] of [['editor', 'edit'], ['reader', 'read']] as const) {
    const res = await rest('creator', 'POST', `/api/vaults/${vaultId}/shares`, {
      granteeType: 'user',
      granteeId: userId[who],
      permission,
    })
    expect(res.statusCode).toBeLessThan(300)
  }
  // The same rules through a team share: one team with edit, one with read.
  for (const [who, permission] of [['teamEditor', 'edit'], ['teamReader', 'read']] as const) {
    const team = (await rest('creator', 'POST', '/api/teams', { name: `${who} team` })).json<{ id: string }>()
    expect((await rest('creator', 'POST', `/api/teams/${team.id}/members`, { userId: userId[who] })).statusCode).toBeLessThan(300)
    const res = await rest('creator', 'POST', `/api/vaults/${vaultId}/shares`, { granteeType: 'team', granteeId: team.id, permission })
    expect(res.statusCode).toBeLessThan(300)
  }

  for (const who of Object.keys(users) as Who[]) {
    const { token } = (await rest(who, 'POST', '/api/mcp-connections', { name: `${who}-agent`, scope: 'account' })).json<{ token: string }>()
    const client = new Client({ name: 'perspective-test', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    )
    clients.push(client)
    mcp[who] = client
  }
})

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('vault perspectives need edit access (REST)', () => {
  it('a read-only member cannot save a shared perspective into the vault', async () => {
    const res = await rest('reader', 'POST', '/api/graph/perspectives', { name: 'reader publish', vaultId, isShared: true })
    expect(res.statusCode).toBe(404)
    const visible = await rest('creator', 'GET', `/api/graph/perspectives?vaultId=${vaultId}`)
    expect(visible.json<Perspective[]>().some((p) => p.name === 'reader publish')).toBe(false)
  })

  it('an edit member saves one, and a reader still sees it', async () => {
    const saved = await saveRest('editor', { name: 'editor view', vaultId, isShared: true })
    expect(saved.vaultId).toBe(vaultId)
    expect(await listRest('reader', `?vaultId=${vaultId}`)).toContain(saved.id)
  })

  it('a read-only member cannot delete a perspective, not even one they created', async () => {
    const editors = await saveRest('editor', { name: 'editor keep', vaultId })
    expect((await rest('reader', 'DELETE', `/api/graph/perspectives/${editors.id}`)).statusCode).toBe(404)

    const own = await insertPerspective('reader', 'saved before the share became read-only')
    expect((await rest('reader', 'DELETE', `/api/graph/perspectives/${own}`)).statusCode).toBe(404)
    expect(await listRest('creator', `?vaultId=${vaultId}`)).toEqual(expect.arrayContaining([editors.id, own]))
  })

  it('an editor deletes their own perspective; only the vault owner deletes another member perspective', async () => {
    const ownersView = await saveRest('creator', { name: 'owner view', vaultId })
    expect((await rest('editor', 'DELETE', `/api/graph/perspectives/${ownersView.id}`)).statusCode).toBe(403)

    const own = await saveRest('editor', { name: 'editor temp', vaultId })
    expect((await rest('editor', 'DELETE', `/api/graph/perspectives/${own.id}`)).statusCode).toBe(200)

    const editors = await saveRest('editor', { name: 'editor moderated', vaultId })
    expect((await rest('creator', 'DELETE', `/api/graph/perspectives/${editors.id}`)).statusCode).toBe(200)
    expect(await listRest('creator', `?vaultId=${vaultId}`)).not.toContain(editors.id)
  })
})

describe('global perspectives are personal (REST)', () => {
  it('is listed to its creator only, not to another account or another instance admin', async () => {
    const global = await saveRest('creator', { name: 'creator global', isShared: true })
    expect(global.vaultId).toBeNull()

    expect(await listRest('creator')).toContain(global.id)
    for (const who of ['otherAdmin', 'member', 'editor', 'reader'] as const) {
      expect(await listRest(who)).not.toContain(global.id)
    }
  })

  it('a private global perspective of one admin is not listed to another admin', async () => {
    const global = await saveRest('creator', { name: 'creator private global', isShared: false })
    expect(await listRest('creator')).toContain(global.id)
    expect(await listRest('otherAdmin')).not.toContain(global.id)
  })

  it('only its creator deletes it; anyone else, an admin too, gets not found', async () => {
    const global = await saveRest('creator', { name: 'creator global delete', isShared: true })

    expect((await rest('member', 'DELETE', `/api/graph/perspectives/${global.id}`)).statusCode).toBe(404)
    expect((await rest('otherAdmin', 'DELETE', `/api/graph/perspectives/${global.id}`)).statusCode).toBe(404)
    expect(await listRest('creator')).toContain(global.id)

    expect((await rest('creator', 'DELETE', `/api/graph/perspectives/${global.id}`)).statusCode).toBe(200)
    expect(await listRest('creator')).not.toContain(global.id)
  })
})

describe('the same rules over MCP', () => {
  it('a read-only member cannot save into the vault; an edit member can', async () => {
    const denied = await call('reader', 'save_graph_perspective', { vaultId, name: 'mcp reader publish', isShared: true })
    expect(denied.isError).toBe(true)
    expect(denied.text).toMatch(/not found/)
    const names = (await rest('creator', 'GET', `/api/graph/perspectives?vaultId=${vaultId}`)).json<Perspective[]>()
    expect(names.some((p) => p.name === 'mcp reader publish')).toBe(false)

    const saved = await call('editor', 'save_graph_perspective', { vaultId, name: 'mcp editor view' })
    expect(saved.isError).toBe(false)
    expect(await listMcp('reader', { vaultId })).toContain(perspectivesOf(saved.text)[0]!.id)
  })

  it('a read-only member cannot delete a perspective, not even one they created', async () => {
    const own = await insertPerspective('reader', 'mcp saved before read-only')
    const r = await call('reader', 'delete_graph_perspective', { id: own })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/not found/)
    expect(await listMcp('creator', { vaultId })).toContain(own)
  })

  it('a global perspective is listed to its creator only, and only its creator deletes it', async () => {
    const saved = await call('creator', 'save_graph_perspective', { name: 'mcp creator global', isShared: true })
    expect(saved.isError).toBe(false)
    const global = perspectivesOf(saved.text)[0]!.id

    expect(await listMcp('creator')).toContain(global)
    for (const who of ['otherAdmin', 'member', 'editor'] as const) {
      expect(await listMcp(who)).not.toContain(global)
    }

    for (const who of ['member', 'otherAdmin'] as const) {
      const denied = await call(who, 'delete_graph_perspective', { id: global })
      expect(denied.isError).toBe(true)
      expect(denied.text).toMatch(/not found/)
    }
    expect(await listMcp('creator')).toContain(global)

    const byCreator = await call('creator', 'delete_graph_perspective', { id: global })
    expect(byCreator.isError).toBe(false)
    expect(await listMcp('creator')).not.toContain(global)
  })

  it('an editor cannot delete another member perspective; the vault owner can', async () => {
    const ownersView = perspectivesOf((await call('creator', 'save_graph_perspective', { vaultId, name: 'mcp owner view' })).text)[0]!.id
    const byEditor = await call('editor', 'delete_graph_perspective', { id: ownersView })
    expect(byEditor.isError).toBe(true)
    expect(byEditor.text).toMatch(/owner permission required/)
    expect(await listMcp('creator', { vaultId })).toContain(ownersView)

    const editors = perspectivesOf((await call('editor', 'save_graph_perspective', { vaultId, name: 'mcp editor moderated' })).text)[0]!.id
    const byOwner = await call('creator', 'delete_graph_perspective', { id: editors })
    expect(byOwner.isError).toBe(false)
    expect(await listMcp('creator', { vaultId })).not.toContain(editors)
  })
})

describe('edit access through a team share', () => {
  it('a member of an edit team saves and deletes; a member of a read-only team cannot save', async () => {
    const saved = await saveRest('teamEditor', { name: 'team editor view', vaultId })
    expect((await rest('teamEditor', 'DELETE', `/api/graph/perspectives/${saved.id}`)).statusCode).toBe(200)

    expect((await rest('teamReader', 'POST', '/api/graph/perspectives', { name: 'team reader publish', vaultId })).statusCode).toBe(404)
    const denied = await call('teamReader', 'save_graph_perspective', { vaultId, name: 'mcp team reader publish' })
    expect(denied.isError).toBe(true)
    expect(denied.text).toMatch(/not found/)
    // The read-only team member still lists the vault's shared perspectives; neither save landed.
    await saveRest('editor', { name: 'shared with the read team', vaultId, isShared: true })
    const names = (await rest('teamReader', 'GET', `/api/graph/perspectives?vaultId=${vaultId}`)).json<Perspective[]>().map((p) => p.name)
    expect(names).toContain('shared with the read team')
    expect(names).not.toContain('team reader publish')
    expect(names).not.toContain('mcp team reader publish')
  })
})
