// Every MCP tool rejects arguments it does not declare (#437). Before, the
// schemas stripped them: `create_note {content}` made a note with an empty
// body and no error. The refusal names the unknown key, suggests the real one
// when it is close, and lists the tool's parameters; tools/list advertises
// `additionalProperties: false` so clients know up front.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { listMcpTools } from '../src/mcp/server.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
interface JsonSchema {
  type?: unknown
  properties?: Record<string, JsonSchema>
  additionalProperties?: unknown
  anyOf?: JsonSchema[]
}

let app: FastifyInstance
let baseUrl: string
let ownerCookie: string
let vaultId: string
let repositoryId: string
let account: Client
const clients: Client[] = []

/** A string field of a JSON response body. */
function field(body: unknown, key: string): string {
  if (body && typeof body === 'object' && key in body) {
    const value: unknown = Reflect.get(body, key)
    if (typeof value === 'string') return value
  }
  throw new Error(`response has no ${key}: ${JSON.stringify(body)}`)
}

async function post(url: string, body: Args): Promise<unknown> {
  const res = await app.inject({ method: 'POST', url, headers: { cookie: ownerCookie }, body })
  if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${url}: ${res.statusCode} ${res.body}`)
  return res.json()
}

async function mint(body: Args): Promise<Client> {
  const token = field(await post('/api/mcp-connections', body), 'token')
  const client = new Client({ name: 'strict-args-test', version: '0.0.0' })
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
  const result = await client.callTool({ name, arguments: args })
  const content: unknown[] = Array.isArray(result.content) ? result.content : []
  return { isError: result.isError === true, text: content.map((c) => field(c, 'text')).join('') }
}

/** A refused call's error envelope (#439), after checking it is an error. */
async function refused(client: Client, name: string, args: Args): Promise<{ code: string; message: string; field?: string; suggestions?: string[] }> {
  const r = await call(client, name, args)
  expect(r.isError, `${name} ${JSON.stringify(args)} answered ${r.text.slice(0, 200)}`).toBe(true)
  const envelope = JSON.parse(r.text) as { error: { code: string; message: string; field?: string; suggestions?: string[] } }
  return envelope.error
}

/** A refused call's message. */
async function refusal(client: Client, name: string, args: Args): Promise<string> {
  return (await refused(client, name, args)).message
}

/** Every object node of a JSON Schema, with its path, through `properties` and `anyOf`. */
function objectNodes(schema: JsonSchema, path: string): Array<[string, JsonSchema]> {
  const out: Array<[string, JsonSchema]> = []
  if (schema.type === 'object') out.push([path, schema])
  for (const [k, v] of Object.entries(schema.properties ?? {})) out.push(...objectNodes(v, `${path}.${k}`))
  for (const v of schema.anyOf ?? []) out.push(...objectNodes(v, path))
  return out
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  vaultId = field(await post('/api/vaults', { name: 'strict-args' }), 'id')
  repositoryId = field(await post('/api/repositories', { name: 'strict-args-repo', ingestionMethod: 'agent_push' }), 'id')
  account = await mint({ name: 'strict-account-admin', scope: 'account', access: 'admin' })
}, 60_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('MCP tools reject unknown arguments (#437)', () => {
  it('create_note {content} is refused with the real parameter names, and no note is created', async () => {
    const path = 'concepts/strict-content-probe'
    const text = await refusal(account, 'create_note', { vaultId, path, content: 'the body I meant to write' })
    expect(text).toMatch(/unknown argument "content" \(did you mean "body"\?\)/)
    expect(await refused(account, 'create_note', { vaultId, path, content: 'x' })).toMatchObject({
      code: 'INVALID_ARGUMENT',
      field: 'content',
      suggestions: ['body'],
    })
    for (const param of ['vaultId', 'path', 'type', 'name', 'frontmatter', 'body']) expect(text).toContain(param)
    expect(await refusal(account, 'read_note', { vaultId, path })).toMatch(/not found/)
  })

  it('every registered tool refuses an unknown key and names it and every real parameter', async () => {
    const listed = (await account.listTools()).tools
    expect(listed.map((t) => t.name).sort()).toEqual(listMcpTools().map((t) => t.name).sort())
    for (const t of listed) {
      const params = Object.keys(t.inputSchema.properties ?? {})
      const text = await refusal(account, t.name, { zzNotAParameter: 1 })
      expect(text, t.name).toContain('"zzNotAParameter"')
      if (params.length === 0) expect(text, t.name).toContain(`${t.name} takes no arguments`)
      for (const param of params) expect(text, `${t.name} lists ${param}`).toContain(param)
    }
  })

  it('pinned connections get the same refusal, and destructive tools do nothing', async () => {
    const vaultPinned = await mint({ name: 'strict-vault-pinned', scope: 'vault', vaultId, access: 'admin' })
    const repoPinned = await mint({ name: 'strict-repo-pinned', scope: 'repository', repositoryId, access: 'admin' })
    expect(await refusal(vaultPinned, 'read_note', { path: 'concepts/x', notePath: 'concepts/x' })).toMatch(
      /unknown argument "notePath" \(did you mean "path"\?\)/,
    )
    expect(await refusal(vaultPinned, 'delete_vault', { force: true })).toMatch(/unknown argument "force"/)
    expect(await refusal(repoPinned, 'read_file', { path: 'README.md', line: 3 })).toMatch(/unknown argument "line"/)
    expect(await refusal(repoPinned, 'delete_repository', { confirm: true })).toMatch(/unknown argument "confirm"/)
    // Both survived the refused destructive calls.
    expect((await call(account, 'browse_vault', { vaultId })).isError).toBe(false)
    expect((await call(account, 'repository_status', { repositoryId })).isError).toBe(false)
  })

  it('suggests the real name for close or commonly guessed keys', async () => {
    expect(await refusal(account, 'browse_vault', { vault_id: vaultId })).toMatch(/"vault_id" \(did you mean "vaultId"\?\)/)
    expect(await refusal(account, 'search', { vaultId, q: 'x' })).toMatch(/"q" \(did you mean "query"\?\)/)
    expect(await refusal(account, 'graph', { vaultId, tag: ['a'] })).toMatch(/"tag" \(did you mean "tags"\?\)/)
    expect(await refusal(account, 'rename_note', { vaultId, from: 'concepts/a', newName: 'b' })).toMatch(
      /"newName" \(did you mean "toName"\?\)/,
    )
    const two = await refusal(account, 'edit_note', { vaultId, path: 'concepts/a', text: 'x', zzOther: 1 })
    expect(two).toMatch(/unknown arguments "text" \(did you mean "body"\?\), "zzOther"/)
  })

  it('nested filters reject unknown keys; free-form frontmatter keeps any key', async () => {
    const text = await refusal(account, 'save_graph_perspective', { vaultId, name: 'p', filters: { type: ['concepts'] } })
    expect(text).toMatch(/unknown argument "type" \(did you mean "types"\?\)/)
    for (const key of ['types', 'tags', 'since', 'until', 'colorMode']) expect(text).toContain(key)
    expect((await call(account, 'list_graph_perspectives', { vaultId })).text).toBe('[]')
    expect((await call(account, 'save_graph_perspective', { vaultId, name: 'p', filters: { types: ['concepts'] } })).isError).toBe(false)

    // Frontmatter keys are the author's own: the schema accepts any (values are checked by the note store).
    const frontmatter = { type: 'concepts', 'custom-key': 'x', anything_else: [1, 'two'] }
    const created = await call(account, 'create_note', { vaultId, path: 'concepts/free-form', frontmatter, body: 'hello' })
    expect(created.isError, created.text).toBe(false)
    const edited = await call(account, 'edit_note', {
      vaultId,
      path: 'concepts/free-form',
      frontmatter: { ...frontmatter, another: true },
    })
    expect(edited.isError, edited.text).toBe(false)
    const read = JSON.parse((await call(account, 'read_note', { vaultId, path: 'concepts/free-form' })).text) as Args
    expect(read.frontmatter).toMatchObject({ 'custom-key': 'x', anything_else: [1, 'two'], another: true })
    expect(read.body).toContain('hello')
  })

  it('tools/list advertises additionalProperties: false on every object except free-form maps', async () => {
    const freeForm: Record<string, true> = { frontmatter: true, folders: true, folderColors: true, vaultColors: true, favorites: true }
    for (const t of (await account.listTools()).tools) {
      for (const [path, node] of objectNodes(t.inputSchema as JsonSchema, t.name)) {
        const key = path.split('.').at(-1) ?? ''
        if (freeForm[key]) expect(node.additionalProperties, path).not.toBe(false)
        else expect(node.additionalProperties, path).toBe(false)
      }
    }
  })
})
