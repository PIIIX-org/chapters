// #933: REST and MCP bounded only the note body (#491); frontmatter was
// bounded by the request size alone, and per-key merges (#438) grew it
// across requests without limit. The stored frontmatter is now bounded by
// the same ELARA_NOTE_MAX_BYTES, measured as the relay measures it (#780):
// keys and values as JSON, counted apart from the body.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { createNote, readNote } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

/** A small cap keeps the payloads small; the measure is the same at any cap. */
const CAP = 4096

let app: FastifyInstance
let baseUrl: string
let cookie: string
let mcpToken: string
let vaultId: string
const clients: Client[] = []

async function mcpClient(): Promise<Client> {
  const client = new Client({ name: 'fm-cap-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${mcpToken}` } },
    }),
  )
  clients.push(client)
  return client
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content[0]?.text ?? ''
}

async function storedFrontmatter(path: string): Promise<Record<string, unknown>> {
  return (await readNote(vaultId, path))!.frontmatter as Record<string, unknown>
}

beforeAll(async () => {
  process.env.ELARA_NOTE_MAX_BYTES = String(CAP)
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (
    (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Frontmatter cap vault' } })).json() as {
      id: string
    }
  ).id
  mcpToken = (
    (await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie },
      body: { name: 'fm-cap-agent', scope: 'vault', vaultId },
    })).json() as { token: string }
  ).token
})

afterAll(async () => {
  delete process.env.ELARA_NOTE_MAX_BYTES
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('note frontmatter size cap (#933)', () => {
  it('REST POST and PUT refuse frontmatter over the cap with 413 naming the limit, and store nothing', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'docs', name: 'rest-big', frontmatter: { blob: 'x'.repeat(CAP) }, body: 'short' },
    })
    expect(created.statusCode).toBe(413)
    expect((created.json() as { error: string }).error).toContain(String(CAP))
    expect(await readNote(vaultId, 'docs/rest-big')).toBeNull()

    const ok = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'docs', name: 'rest-fm', body: 'short' },
    })
    expect(ok.statusCode).toBe(200)
    const put = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/docs/rest-fm`,
      headers: { cookie },
      body: { frontmatter: { type: 'docs', blob: 'x'.repeat(CAP) } },
    })
    expect(put.statusCode).toBe(413)
    expect((put.json() as { error: string }).error).toContain('frontmatter')
    expect(await storedFrontmatter('docs/rest-fm')).not.toHaveProperty('blob')
  })

  it('many small MCP edit_note merges grow the frontmatter only up to the cap; the one that would pass it is refused', async () => {
    const client = await mcpClient()
    const created = await client.callTool({ name: 'create_note', arguments: { vaultId, path: 'docs/fm-grow', body: 'short' } })
    expect(created.isError).toBeFalsy()
    const value = 'v'.repeat(200)
    let refused: Awaited<ReturnType<Client['callTool']>> | null = null
    for (let i = 0; i < 40 && !refused; i++) {
      const before = await storedFrontmatter('docs/fm-grow')
      const res = await client.callTool({
        name: 'edit_note',
        arguments: { vaultId, path: 'docs/fm-grow', frontmatter: { [`k${i}`]: value } },
      })
      if (res.isError) {
        refused = res
        // Never partially applied: the refused merge leaves the stored map as it was.
        expect(await storedFrontmatter('docs/fm-grow')).toEqual(before)
      }
    }
    expect(refused).not.toBeNull()
    expect(textOf(refused!)).toContain(String(CAP))
    const stored = Object.entries(await storedFrontmatter('docs/fm-grow'))
    expect(stored.reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(JSON.stringify(v)), 0)).toBeLessThanOrEqual(CAP)

    const upsert = await client.callTool({
      name: 'upsert_note',
      arguments: { vaultId, path: 'docs/fm-grow', frontmatter: { huge: 'h'.repeat(CAP) } },
    })
    expect(upsert.isError).toBe(true)
    const fresh = await client.callTool({
      name: 'create_note',
      arguments: { vaultId, path: 'docs/fm-new', frontmatter: { huge: 'h'.repeat(CAP) }, body: 'x' },
    })
    expect(fresh.isError).toBe(true)
    expect(await readNote(vaultId, 'docs/fm-new')).toBeNull()
  })

  it('a note whose frontmatter is already over the cap can shrink but not grow', async () => {
    process.env.ELARA_NOTE_MAX_BYTES = String(4 * CAP)
    try {
      await createNote(vaultId, { path: 'docs/fm-legacy', frontmatter: { a: 'a'.repeat(CAP), b: 'b'.repeat(CAP) }, body: 'short' })
    } finally {
      process.env.ELARA_NOTE_MAX_BYTES = String(CAP)
    }
    const client = await mcpClient()
    const grow = await client.callTool({ name: 'edit_note', arguments: { vaultId, path: 'docs/fm-legacy', frontmatter: { c: 'c' } } })
    expect(grow.isError).toBe(true)
    expect(await storedFrontmatter('docs/fm-legacy')).not.toHaveProperty('c')

    // A body-only edit keeps the frontmatter as it is: allowed.
    const body = await client.callTool({ name: 'edit_note', arguments: { vaultId, path: 'docs/fm-legacy', body: 'other' } })
    expect(body.isError).toBeFalsy()

    const shrink = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/docs/fm-legacy`,
      headers: { cookie },
      body: { removeKeys: ['b'] },
    })
    expect(shrink.statusCode).toBe(200)
    expect(await storedFrontmatter('docs/fm-legacy')).not.toHaveProperty('b')
  })
})
