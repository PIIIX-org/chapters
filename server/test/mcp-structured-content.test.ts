// #433 (ADR-004 §2.1, D6 default): every tool answer that is a JSON object
// also comes as `structuredContent`, the same object as the text, which stays
// the full JSON (many clients show the model only `content`). An answer that
// is not an object (the admin list tools' bare arrays) has none: MCP's
// `structuredContent` is an object. The write tools list one shared
// `outputSchema` (`rev`, `status`, `indexed`, other keys allowed), so every
// write answer validates, in the SDK on the server and in this real client;
// an error answer stays `isError` text and is not validated.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { retryResult } from '../src/mcp/write-result.js'
import { createNote } from '../src/notes/store.js'
import { StoreBusyError } from '../src/notes/store-tx.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie, toolText } from './helpers.js'

type Args = Record<string, unknown>
type Json = Record<string, unknown>

/** The tools that answer through runWrite (write-result.ts) and list the shared outputSchema. */
const WRITE_TOOLS = ['create_note', 'edit_note', 'append_note', 'upsert_note', 'rename_note', 'delete_note', 'restore_note', 'revert_note']

let app: FastifyInstance
let vaultId: string
let repoId: string
let agent: Client
const clients: Client[] = []

/**
 * One call through the real client (which validates `structuredContent`
 * against a listed outputSchema and throws when it does not match). A
 * successful object answer must carry `structuredContent` equal to its
 * parsed text (read_note's body block put back in its key, #445); any other
 * answer must carry none.
 */
async function call(tool: string, args: Args): Promise<{ isError: boolean; text: string; json: unknown; structured: unknown }> {
  resetRateLimits()
  const result = await agent.callTool({ name: tool, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  const isError = result.isError === true
  expect(content.length, `${tool}: one text block, and read_note's body after it`).toBe(tool === 'read_note' && !isError ? 2 : 1)
  const text = toolText(content)
  let json: unknown
  if (!isError) {
    json = JSON.parse(text)
    const isObject = json !== null && typeof json === 'object' && !Array.isArray(json)
    if (isObject) expect(result.structuredContent, `${tool}: structuredContent is the text's JSON`).toEqual(json)
    else expect(result.structuredContent, `${tool}: a non-object answer has no structuredContent`).toBeUndefined()
  }
  return { isError, text, json, structured: result.structuredContent }
}

async function ok(tool: string, args: Args): Promise<Json> {
  const r = await call(tool, args)
  expect(r.isError, `${tool}: ${r.text.slice(0, 300)}`).toBe(false)
  return r.json as Json
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'structured vault' } })).json<{ id: string }>().id
  repoId = (
    await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'structured-repo', ingestionMethod: 'agent_push' } })
  ).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'structured-agent', scope: 'account' } })
  agent = new Client({ name: 'structured-content-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  clients.push(agent)
  await createNote(vaultId, { path: 'docs/alpha', body: 'Alpha links to [[docs/beta]].\n' })
  await createNote(vaultId, { path: 'docs/beta', body: 'Beta.\n' })
  const files = [{ path: 'src/alpha.ts', content: 'export function alphaHandler(input: string) {\n  return input\n}\n' }]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await flushExtraction()
  resetRateLimits()
  // Lists the tools, so the client knows the output schemas it validates against.
  await agent.listTools()
}, 180_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('tools/list: outputSchema on the write tools only', () => {
  it('lists the shared write-result schema on every runWrite tool, and none on the other tools', async () => {
    resetRateLimits()
    const { tools } = await agent.listTools()
    const withSchema = tools.filter((t) => t.outputSchema !== undefined).map((t) => t.name)
    expect(withSchema.sort()).toEqual([...WRITE_TOOLS].sort())
    const schemas = tools.filter((t) => t.outputSchema !== undefined).map((t) => JSON.stringify(t.outputSchema))
    expect(new Set(schemas).size, 'one shared schema').toBe(1)
    const schema = tools.find((t) => t.name === 'edit_note')!.outputSchema!
    expect(schema).not.toHaveProperty('$schema')
    expect(schema.type).toBe('object')
    expect([...(schema.required ?? [])].sort()).toEqual(['indexed', 'rev', 'status'])
    // Other keys (path, diff_stats, conflicts, replayed, ...) are allowed, so no write answer fails validation.
    expect((schema as Json).additionalProperties).not.toBe(false)
  })
})

describe('structuredContent is the text JSON, per tool family', () => {
  it('vault tools: an object answer has it; a bare-array answer has none', async () => {
    const vaults = await call('list_vaults', {})
    expect(Array.isArray(vaults.json)).toBe(true)
    expect(vaults.structured).toBeUndefined()
    await ok('browse_vault', { vaultId, recursive: true })
    await ok('get_vault_preferences', {})
  })

  it('note reads and history', async () => {
    const read = await ok('read_note', { vaultId, path: 'docs/alpha' })
    expect(read.body).toBe('Alpha links to [[docs/beta]].\n')
    const history = await ok('note_history', { vaultId, path: 'docs/alpha' })
    const [revision] = history.revisions as Array<{ id: string }>
    await ok('get_revision', { vaultId, revisionId: revision!.id })
  })

  it('repository tools, search and graph', async () => {
    await ok('browse_repository', { repositoryId: repoId })
    await ok('read_file', { repositoryId: repoId, path: 'src/alpha.ts' })
    await ok('repository_status', { repositoryId: repoId })
    expect(await ok('find_symbols', { repositoryId: repoId, query: 'alphaHandler' })).toHaveProperty('truncated')
    // search answers its envelope (#441, #442, #458), with the budget's `truncated`.
    expect(await ok('search', { vaultId, query: 'alpha' })).toMatchObject({ status: 'ok', truncated: false })
    await ok('graph', { vaultId })
  })
})

describe('write answers validate against the listed outputSchema', () => {
  it('create (applied, dry run, replayed), edit (merged, conflicted), append, upsert, rename, delete, restore, revert', async () => {
    const preview = await ok('create_note', { vaultId, path: 'w/one', body: 'a\nb\nc\n', dry_run: true })
    expect(preview).toMatchObject({ status: 'applied', dry_run: true, indexed: false })
    const created = await ok('create_note', { vaultId, path: 'w/one', body: 'a\nb\nc\n', idempotency_key: 'k-one' })
    expect(created).toMatchObject({ path: 'w/one', rev: 1, status: 'applied' })
    expect(typeof created.createdAt).toBe('string')
    const replayed = await ok('create_note', { vaultId, path: 'w/one', body: 'a\nb\nc\n', idempotency_key: 'k-one' })
    expect(replayed).toMatchObject({ path: 'w/one', rev: 1, status: 'applied', replayed: true })
    const edited = await ok('edit_note', { vaultId, path: 'w/one', body: 'a\nB\nc\n', base_rev: 1 })
    expect(edited).toMatchObject({ status: 'applied', rev: 2 })
    const merged = await ok('edit_note', { vaultId, path: 'w/one', body: 'a\nb\nc\nd\n', base_rev: 1 })
    expect(merged).toMatchObject({ status: 'merged', rev: 3 })
    const conflicted = await ok('edit_note', { vaultId, path: 'w/one', body: 'a\nX\nc\n', base_rev: 1 })
    expect(conflicted).toMatchObject({ status: 'conflicted', rev: 3, diff_stats: null })

    await ok('append_note', { vaultId, path: 'w/one', text: 'tail' })
    expect(await ok('upsert_note', { vaultId, path: 'w/two', body: 'two\n' })).toMatchObject({ created: true, status: 'applied' })
    await ok('rename_note', { vaultId, from: 'w/two', toName: 'three' })
    const deleted = await ok('delete_note', { vaultId, path: 'w/three' })
    expect(deleted).toMatchObject({ trashed: true, status: 'applied' })
    await ok('restore_note', { vaultId, noteId: deleted.id })

    const history = await ok('note_history', { vaultId, path: 'w/one' })
    const oldest = (history.revisions as Array<{ id: string }>).at(-1)!
    await ok('revert_note', { vaultId, path: 'w/one', revisionId: oldest.id })
  })

  it('a `retry` answer (the store was busy) fits the listed schema too, with the validator the client uses', async () => {
    resetRateLimits()
    const { tools } = await agent.listTools()
    const validate = new AjvJsonSchemaValidator().getValidator(tools.find((t) => t.name === 'create_note')!.outputSchema!)
    const retry = JSON.parse(JSON.stringify(retryResult(new StoreBusyError('lock timeout')))) as unknown
    expect(validate(retry)).toMatchObject({ valid: true })
    expect(validate({ rev: 1, status: 'done', indexed: true }).valid, 'an unknown status is refused').toBe(false)
  })
})

describe('errors', () => {
  it('a failed call is the error envelope (#439) as text without structuredContent, on a tool without and with an outputSchema', async () => {
    for (const [tool, args] of [
      ['read_note', { vaultId, path: 'docs/missing' }],
      ['edit_note', { vaultId, path: 'docs/missing', body: 'x' }],
      ['delete_note', { vaultId, path: 'docs/missing' }],
    ] as const) {
      const r = await call(tool, args)
      expect(r.isError, tool).toBe(true)
      expect(r.text).toBe('{"error":{"code":"NOT_FOUND","message":"note not found","retryable":false}}')
      expect(r.structured).toBeUndefined()
    }
  })
})
