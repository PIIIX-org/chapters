// #490: concurrent create_note calls into one folder returned errors for
// notes that had been created (4–10 of 16 in the lab). Every create
// regenerates the folder's index.md, and every atomic write used the same
// temp name `${file}.tmp`, so the concurrent index writes renamed away each
// other's temp file and the losing calls failed with ENOENT after their note
// was already stored. Unique temp names (#401) fixed it; this pins it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { readNote } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

// Every rename waits a beat, so a write's temp file sits on disk long enough
// for the other creates' index writes to reach it: the race is hit on every
// run rather than by chance. Real time on purpose: the writes hit real
// Postgres and disk, which fake timers cannot drive.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 15)
      await promise
      return actual.rename(...args)
    },
  }
})

const N = 16
const FOLDER = 'concepts/burst'
const pathOf = (i: number) => `${FOLDER}/note-${i}`

let app: FastifyInstance
let vaultId: string
const clients: Client[] = []

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Burst vault' } })
  ).json().id
  const token = (
    await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie },
      body: { name: 'burst', scope: 'account' },
    })
  ).json().token as string
  // One MCP session per writer, like the lab's N concurrent agents.
  for (let i = 0; i < N; i++) {
    const client = new Client({ name: `burst-${i}`, version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    )
    clients.push(client)
  }
})

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()))
  await app.close()
})

describe('concurrent create_note into one folder (#490)', () => {
  it('every call succeeds exactly when its note exists, and index.md lists every note', async () => {
    resetRateLimits()
    const outcomes = await Promise.all(
      clients.map(async (client, i) => {
        try {
          const result = await client.callTool({
            name: 'create_note',
            arguments: {
              vaultId,
              path: pathOf(i),
              frontmatter: { type: 'concepts', title: `burst ${i}` },
              body: `burst ${i}\n`,
            },
          })
          const content = result.content as Array<{ type: string; text?: string }>
          return { i, ok: result.isError !== true, text: content.map((c) => c.text ?? '').join('') }
        } catch (err) {
          return { i, ok: false, text: String(err) }
        }
      }),
    )

    const report = await Promise.all(
      outcomes.map(async (o) => ({ ...o, exists: (await readNote(vaultId, pathOf(o.i))) !== null })),
    )
    // No call errors for a note it created, and none succeeds for a missing one.
    expect(report.filter((r) => r.ok !== r.exists)).toEqual([])
    expect(report.filter((r) => !r.ok)).toEqual([])

    const index = await readFile(join(config.dataDir, 'vaults', vaultId, FOLDER, 'index.md'), 'utf8')
    const unlisted = report.filter((r) => !new RegExp(`note-${r.i}(?!\\d)`).test(index)).map((r) => r.i)
    expect(unlisted).toEqual([])
  }, 30_000)
})
