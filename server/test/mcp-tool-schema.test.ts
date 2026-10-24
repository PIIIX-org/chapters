// tools/list is what every agent pays for before its first call (#430): a
// uuid argument is advertised as `format: "uuid"` without the long regex
// zod adds, every top-level parameter says what it is, and the whole list
// for an admin account token stays under a ceiling.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

/**
 * Characters of `JSON.stringify({ tools })` for an admin account token (#430: 51,972 before, 46,385 after).
 * With `budget_tokens`, `cursor` and the envelope sentence on the 10 budgeted tools (#420, #422): 49,084.
 * With `browse_repository`'s `path` (#424) and `browse_vault`'s `fields` (#425): 49,388.
 * With `graph`'s `neighborsOf`, `depth`, `edgeTypes` and `limit` (#426; its description kept to the old length): 49,805.
 * Two-sentence descriptions and no default `$schema`/`execution` fields (#429): 37,512. The write-result
 * `outputSchema` on the 8 write tools (#433, 250 characters each): 39,512. Annotations on all 60 tools (#434:
 * `readOnlyHint` on the reads, `destructiveHint` and `idempotentHint` on the writes): 42,101. The reader and
 * writer budgets are in mcp-tool-budget.test.ts.
 */
const TOOLS_LIST_CEILING = 43_000

let app: FastifyInstance
let client: Client
let tools: Tool[]

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp-connections',
    headers: { cookie },
    body: { name: 'tool-schema', scope: 'account', access: 'admin' },
  })
  const { token } = res.json<{ token: string }>()
  client = new Client({ name: 'tool-schema-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  resetRateLimits()
  tools = (await client.listTools()).tools
}, 60_000)

afterAll(async () => {
  await client?.close().catch(() => {})
  await app.close()
})

/** Every schema node under `node`, with its JSON path. */
function* walk(
  node: unknown,
  path: string,
): Generator<[string, Record<string, unknown>]> {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* walk(item, `${path}[${i}]`)
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    yield [path, obj]
    for (const [key, value] of Object.entries(obj))
      yield* walk(value, `${path}.${key}`)
  }
}

describe('tools/list schemas (#430)', () => {
  it('advertises uuid arguments as format "uuid" without a pattern', () => {
    const uuidFields: string[] = []
    const withPattern: string[] = []
    for (const t of tools) {
      for (const [path, node] of walk(t.inputSchema, t.name)) {
        if (node.format !== 'uuid') continue
        uuidFields.push(path)
        if ('pattern' in node) withPattern.push(path)
      }
    }
    expect(uuidFields.length).toBeGreaterThan(50)
    expect(withPattern).toEqual([])
  })

  it('describes every top-level parameter of every tool', () => {
    const bare: string[] = []
    for (const t of tools) {
      for (const [key, schema] of Object.entries(
        t.inputSchema.properties ?? {},
      )) {
        const description: unknown =
          schema && typeof schema === 'object' && 'description' in schema
            ? schema.description
            : undefined
        if (typeof description !== 'string' || description.trim() === '')
          bare.push(`${t.name}.${key}`)
      }
    }
    expect(bare).toEqual([])
  })

  it('keeps the serialized tools/list under its ceiling', () => {
    const size = JSON.stringify({ tools }).length
    console.log(
      `tools/list (admin account token): ${size} chars, ~${Math.round(size / 4)} tokens`,
    )
    expect(size).toBeLessThan(TOOLS_LIST_CEILING)
  })

  it('still refuses an invalid uuid argument', async () => {
    resetRateLimits()
    const result = await client.callTool({
      name: 'read_note',
      arguments: { vaultId: 'not-a-uuid', path: 'docs/x' },
    })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    // The SDK's refusal, as the error envelope (#439).
    const envelope = JSON.parse(content[0]?.text ?? '') as { error: { code: string; message: string; field?: string } }
    expect(envelope.error).toMatchObject({ code: 'INVALID_ARGUMENT', field: 'vaultId' })
    expect(envelope.error.message).toMatch(/Invalid UUID/i)
  })
})
