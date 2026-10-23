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
 * With the paged-envelope descriptions of the #942 stack merged in: 50,459.
 */
const TOOLS_LIST_CEILING = 51_000

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
    const result = await client
      .callTool({
        name: 'read_note',
        arguments: { vaultId: 'not-a-uuid', path: 'docs/x' },
      })
      .catch((err: unknown) => err)
    const text =
      result instanceof Error ? result.message : JSON.stringify(result)
    expect(text).toMatch(/-32602/)
    expect(text).toMatch(/vaultId/)
    expect(text).toMatch(/Invalid UUID/i)
  })
})
