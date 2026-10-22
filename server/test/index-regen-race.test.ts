// #779: every create regenerates its folder's index.md from a snapshot of the
// live notes, and the read and the write were not serialised: when an older
// snapshot's write landed last, index.md silently left out notes that existed.
// The creates start a few ms apart and each index.md rename into the folder is
// delayed by how stale its snapshot is (fewer notes listed, longer wait) plus
// seeded random jitter, so without a per-folder lock an incomplete snapshot is
// written last on every run.
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
import { flushProjections } from '../src/notes/projector.js'
import { createActiveUser, loginCookie } from './helpers.js'

const N = 16
const FOLDER = 'concepts/race'
const pathOf = (i: number) => `${FOLDER}/note-${i}`

// Real time on purpose: the writes hit real Postgres and disk, which fake
// timers cannot drive. Seeded so a failure reproduces.
const jitter = vi.hoisted(() => {
  let seed = 779
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return Math.floor((seed / 2 ** 31) * 20)
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]).endsWith(join('concepts', 'race', 'index.md'))) {
        const listed = ((await actual.readFile(args[0], 'utf8')).match(/\[\[concepts\/race\/note-/g) ?? []).length
        await new Promise((resolve) => setTimeout(resolve, (16 - listed) * 20 + jitter()))
      }
      return actual.rename(...args)
    },
  }
})

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
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Race vault' } })
  ).json().id
  const token = (
    await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie },
      body: { name: 'race', scope: 'account' },
    })
  ).json().token as string
  for (let i = 0; i < N; i++) {
    const client = new Client({ name: `race-${i}`, version: '0.0.0' })
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

describe('concurrent index.md regeneration in one folder (#779)', () => {
  it('the last index.md written lists every live note', async () => {
    resetRateLimits()
    const outcomes = await Promise.all(
      clients.map(async (client, i) => {
        await new Promise((resolve) => setTimeout(resolve, i * 5))
        const result = await client.callTool({
          name: 'create_note',
          arguments: {
            vaultId,
            path: pathOf(i),
            frontmatter: { type: 'concepts', title: `race ${i}` },
            body: `race ${i}\n`,
          },
        })
        return { i, ok: result.isError !== true }
      }),
    )
    expect(outcomes.filter((o) => !o.ok)).toEqual([])
    for (let i = 0; i < N; i++) expect(await readNote(vaultId, pathOf(i))).not.toBeNull()

    // index.md is a projection written after the creates commit (ADR-003 §7): read it once the projector caught up.
    await flushProjections()
    const index = await readFile(join(config.dataDir, 'vaults', vaultId, FOLDER, 'index.md'), 'utf8')
    const unlisted = outcomes.filter((o) => !new RegExp(`note-${o.i}(?!\\d)`).test(index)).map((o) => o.i)
    expect(unlisted).toEqual([])
  })
})
