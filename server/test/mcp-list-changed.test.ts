// No list-change promises (#436): the MCP endpoint is stateless (a fresh
// server per POST, no session, no GET stream), so it can never send
// notifications/*/list_changed. `initialize` says so with `listChanged:
// false` on tools, prompts and resources, and GET and DELETE on both
// endpoint paths answer 405 with `Allow: POST`, as Streamable HTTP expects
// from a server without a stream.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

const PATHS = ['/mcp', '/elara/mcp'] as const

let app: FastifyInstance
let baseUrl: string
let token: string
const clients: Client[] = []

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp-connections',
    headers: { cookie },
    body: { name: 'list-changed', scope: 'account', access: 'admin' },
  })
  token = res.json<{ token: string }>().token
}, 60_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('listChanged (#436)', () => {
  it('advertises listChanged: false for tools, prompts and resources on both paths', async () => {
    for (const path of PATHS) {
      const client = new Client({ name: 'list-changed-test', version: '0.0.0' })
      resetRateLimits()
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}${path}`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      )
      clients.push(client)
      const capabilities = client.getServerCapabilities()
      expect(capabilities?.tools, path).toEqual({ listChanged: false })
      expect(capabilities?.prompts, path).toEqual({ listChanged: false })
      expect(capabilities?.resources, path).toEqual({ listChanged: false })
    }
  })

  it('answers GET and DELETE with 405 and Allow: POST, with or without a token', async () => {
    for (const url of PATHS) {
      for (const method of ['GET', 'DELETE'] as const) {
        for (const headers of [{ accept: 'text/event-stream' }, { accept: 'text/event-stream', authorization: `Bearer ${token}` }]) {
          const res = await app.inject({ method, url, headers })
          const label = `${method} ${url}${'authorization' in headers ? ' with token' : ''}`
          expect(res.statusCode, label).toBe(405)
          expect(res.headers.allow, label).toBe('POST')
          expect(res.json(), label).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
        }
      }
    }
  })
})
