// The tool manuals are MCP resources (#429): `elara://manual/conventions`,
// and one manual per tool family made from skills/elara/references/mcp-tools.md.
// A token lists and reads only the manuals of tools it lists, and a family
// manual holds only those tools' entries; any other manual answers what an
// unknown resource does.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { listMcpTools } from '../src/mcp/server.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>

const FAMILIES = ['conventions', 'vaults', 'notes', 'repositories', 'search', 'graph', 'teams', 'export']
const uri = (family: string) => `elara://manual/${family}`

let app: FastifyInstance
let baseUrl: string
let ownerCookie: string
let memberId: string
let memberCookie: string
let vaultId: string
let repositoryId: string
let admin: Client
const clients: Client[] = []

function field(body: unknown, key: string): string {
  if (body && typeof body === 'object' && key in body) {
    const value: unknown = Reflect.get(body, key)
    if (typeof value === 'string') return value
  }
  throw new Error(`response has no ${key}: ${JSON.stringify(body)}`)
}

async function post(cookie: string, url: string, body: Args): Promise<unknown> {
  const res = await app.inject({ method: 'POST', url, headers: { cookie }, body })
  if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${url}: ${res.statusCode} ${res.body}`)
  return res.json()
}

async function mint(body: Args, cookie = ownerCookie): Promise<Client> {
  const token = field(await post(cookie, '/api/mcp-connections', body), 'token')
  const client = new Client({ name: 'manuals-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  return client
}

async function manuals(client: Client): Promise<string[]> {
  resetRateLimits()
  return (await client.listResources()).resources.map((r) => r.uri)
}

async function read(client: Client, family: string): Promise<string> {
  resetRateLimits()
  const { contents } = await client.readResource({ uri: uri(family) })
  expect(contents).toHaveLength(1)
  expect(contents[0]).toMatchObject({ uri: uri(family), mimeType: 'text/markdown' })
  return field(contents[0], 'text')
}

/** The tools a manual has an entry for, in its order. */
function entries(text: string): string[] {
  return [...text.matchAll(/^### `([a-z_]+)`/gm)].map((m) => m[1]!)
}

async function refused(client: Client, family: string): Promise<string> {
  resetRateLimits()
  const err = await client.readResource({ uri: uri(family) }).then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )
  expect(err, `${family} was readable`).not.toBeNull()
  return err!
}

async function call(client: Client, name: string, args: Args): Promise<string> {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: args })
  const content: unknown[] = Array.isArray(result.content) ? result.content : []
  const text = content.map((c) => field(c, 'text')).join('')
  expect(result.isError, `${name}: ${text}`).toBeFalsy()
  return text
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  const member = await createActiveUser()
  memberId = member.id
  memberCookie = await loginCookie(app, member.email)
  vaultId = field(await post(ownerCookie, '/api/vaults', { name: 'manuals' }), 'id')
  repositoryId = field(await post(ownerCookie, '/api/repositories', { name: 'manuals-repo', ingestionMethod: 'agent_push' }), 'id')
  admin = await mint({ name: 'manuals-admin', scope: 'account', access: 'admin' })
}, 60_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('tool manuals as MCP resources (#429)', () => {
  it('an admin token lists every manual, and the family manuals document every tool exactly once', async () => {
    expect(await manuals(admin)).toEqual(FAMILIES.map(uri))
    const documented: string[] = []
    for (const family of FAMILIES) {
      const text = await read(admin, family)
      expect(text.startsWith('## '), family).toBe(true)
      documented.push(...entries(text))
    }
    const tools = listMcpTools().map((t) => t.name)
    expect([...documented].sort()).toEqual([...tools].sort())
    expect(entries(await read(admin, 'conventions'))).toEqual([])
  })

  it('a reader token lists the manuals of its tools, with only their entries', async () => {
    const reader = await mint({ name: 'manuals-reader', scope: 'account', access: 'admin', profile: 'reader' })
    expect(await manuals(reader)).toEqual(['conventions', 'vaults', 'notes', 'repositories', 'search', 'graph'].map(uri))
    expect(entries(await read(reader, 'vaults'))).toEqual(['list_vaults', 'browse_vault'])
    expect(entries(await read(reader, 'notes'))).toEqual(['read_note'])
    expect(entries(await read(reader, 'graph'))).toEqual(['graph', 'find_graph_path'])
    // The section's own text (the rules every note write follows) comes with any of its tools.
    expect(await read(reader, 'notes')).toContain('Every write answers the same way')
    expect(await read(reader, 'conventions')).toBe(await read(admin, 'conventions'))
  })

  it('a writer token reads the note writes it lists, and not the others', async () => {
    const writer = await mint({ name: 'manuals-writer', scope: 'account', access: 'admin', profile: 'writer' })
    expect(entries(await read(writer, 'notes'))).toEqual(['read_note', 'create_note', 'edit_note', 'append_note'])
  })

  it('a manual without a listed tool answers exactly what an unknown resource does', async () => {
    const reader = await mint({ name: 'manuals-refused', scope: 'account', access: 'admin', profile: 'reader' })
    expect(await refused(reader, 'teams')).toBe((await refused(reader, 'nonexistent')).replace('nonexistent', 'teams'))
    expect(await refused(reader, 'teams')).toMatch(/Resource elara:\/\/manual\/teams not found/)
    expect(await refused(reader, 'export')).toMatch(/Resource elara:\/\/manual\/export not found/)
  })

  it('pinned tokens and allow-lists narrow the manuals as they narrow tools/list', async () => {
    const vault = await mint({ name: 'manuals-vault', scope: 'vault', vaultId, profile: 'reader' })
    expect(await manuals(vault)).toEqual(['conventions', 'vaults', 'notes', 'search', 'graph'].map(uri))
    expect(entries(await read(vault, 'vaults'))).toEqual(['browse_vault'])
    await refused(vault, 'repositories')

    const repo = await mint({ name: 'manuals-repo', scope: 'repository', repositoryId, profile: 'reader' })
    expect(await manuals(repo)).toEqual(['conventions', 'repositories', 'search', 'graph'].map(uri))
    expect(entries(await read(repo, 'repositories'))).toEqual(['browse_repository', 'read_file'])
    expect(entries(await read(repo, 'search'))).toEqual(['search', 'find_symbols'])

    const limited = await mint({ name: 'manuals-allow-list', scope: 'account', access: 'admin', allowedTools: ['search'] })
    expect(await manuals(limited)).toEqual(['conventions', 'search'].map(uri))
    expect(entries(await read(limited, 'search'))).toEqual(['search'])
  })

  it("a pinned token follows the user's live permission on the pin", async () => {
    const shared = field(await post(ownerCookie, '/api/vaults', { name: 'manuals-shared' }), 'id')
    await call(admin, 'share_vault', { vaultId: shared, granteeType: 'user', granteeId: memberId, permission: 'read' })
    const member = await mint({ name: 'manuals-member', scope: 'vault', vaultId: shared }, memberCookie)
    // Read permission on the pin: the note tools that need edit permission are neither listed nor documented.
    const notes = entries(await read(member, 'notes'))
    expect(notes).toContain('read_note')
    for (const editGated of ['note_history', 'list_trash', 'get_revision']) expect(notes).not.toContain(editGated)

    const shares = JSON.parse(await call(admin, 'list_vault_shares', { vaultId: shared })) as Array<{ id: string }>
    await call(admin, 'revoke_vault_share', { vaultId: shared, shareId: shares[0]!.id })
    // No permission left: no tool, so no manual, on the next request.
    expect(await manuals(member)).toEqual([])
    await refused(member, 'conventions')
  })

  it('answers the same bytes on every read and list', async () => {
    const reader = await mint({ name: 'manuals-stable', scope: 'account', access: 'admin', profile: 'reader' })
    resetRateLimits()
    const first = JSON.stringify(await reader.listResources())
    resetRateLimits()
    expect(JSON.stringify(await reader.listResources())).toBe(first)
    expect(await read(reader, 'notes')).toBe(await read(reader, 'notes'))
  })
})
