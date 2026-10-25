// #680 (ADR-004 §2.9): the epochs every cache key carries. A vault's or a
// repository's `index_epoch` moves with every committed change that search,
// graph or a read could answer differently from (note writes, a collab fold,
// pushes and syncs, extraction and embedding completion), and only that
// scope's. The instance's `permission_epoch` moves with every share, team,
// token or account change. Reads move neither. Each test runs one action
// between two quiet points (no queued embedding, extraction or projection)
// and compares the epochs of every scope it set up.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import * as Y from 'yjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db, sql as pg } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { FailpointError, setFailpointHandler } from '../src/failpoints.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { flushProjections } from '../src/notes/projector.js'
import { appendCollabUpdate, foldPendingCollab, loadCollabState } from '../src/notes/store.js'
import { enqueueExtractions, flushExtraction } from '../src/repositories/extraction-queue.js'
import { syncLocalRepository } from '../src/repositories/scheduler.js'
import { enqueueEmbeddings, flushEmbeddings } from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { createActiveUser, loginCookie, toolText } from './helpers.js'

let app: FastifyInstance
let baseUrl: string
let cookie: string
let client: Client
let pushToken: string
let localDir: string
let otherUserId: string
/** label → id of every scope the tests watch: two vaults, a pushed and a local-path repository. */
const scopes: Record<'A' | 'B', string> & Record<'P' | 'L', string> = { A: '', B: '', P: '', L: '' }

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: args })
  const text = toolText(result.content as unknown[])
  if (result.isError) throw new Error(`${name} failed: ${text}`)
  return text
}
const json = async (name: string, args: Record<string, unknown>) => JSON.parse(await call(name, args)) as Record<string, unknown>

/** Every scope's epoch, read so that a build without them (no `index_epochs`, no `permission_epoch`) reads 0 for each. */
async function epochs(): Promise<Record<string, number>> {
  const [{ has } = { has: false }] = await pg<Array<{ has: boolean }>>`SELECT to_regclass('public.index_epochs') IS NOT NULL AS has`
  const index = has
    ? await pg<Array<{ id: string; epoch: string }>>`
        SELECT scope_id::text AS id, epoch::text FROM index_epochs WHERE scope_id = ANY(${Object.values(scopes)}::uuid[])`
    : []
  const [permission] = await pg<Array<{ epoch: string | null }>>`
    SELECT (SELECT to_jsonb(s) ->> 'permission_epoch' FROM instance_state s WHERE s.id = 'singleton') AS epoch`
  const at = new Map(index.map((r) => [r.id, Number(r.epoch)]))
  return {
    ...Object.fromEntries(Object.entries(scopes).map(([k, id]) => [k === 'A' || k === 'B' ? `vault:${k}` : `repo:${k}`, at.get(id) ?? 0])),
    permission: Number(permission?.epoch ?? 0),
  }
}

/** Waits until no embedding, extraction or projection is queued or running. */
async function settle(): Promise<void> {
  await flushExtraction()
  await flushEmbeddings()
  await flushProjections()
}

/** The epochs `action` moved, from one quiet point to the next. */
async function moved(action: () => Promise<unknown>): Promise<string[]> {
  await settle()
  const before = await epochs()
  await action()
  await settle()
  const after = await epochs()
  return Object.keys(after)
    .filter((k) => after[k]! > before[k]!)
    .sort()
}

async function push(files: Array<{ path: string; content: string }>) {
  const res = await app.inject({
    method: 'POST',
    url: '/repositories/sync',
    headers: { authorization: `Bearer ${pushToken}` },
    body: { files, currentPaths: files.map((f) => f.path) },
  })
  expect(res.statusCode).toBe(200)
}

async function mint(): Promise<{ id: string; token: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'epochs', scope: 'account' } })
  expect(res.statusCode).toBe(200)
  return res.json()
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  otherUserId = (await createActiveUser()).id
  cookie = await loginCookie(app, owner.email)
  for (const k of ['A', 'B'] as const) {
    scopes[k] = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: `epochs ${k}` } })).json().id
  }
  scopes.P = (
    await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'epochs-push', ingestionMethod: 'agent_push' } })
  ).json().id
  pushToken = (await app.inject({ method: 'POST', url: `/api/repositories/${scopes.P}/sync-tokens`, headers: { cookie } })).json().token
  localDir = await mkdtemp(join(tmpdir(), 'cache-epochs-'))
  await writeFile(join(localDir, 'main.ts'), 'export function main() {\n  return 1\n}\n')
  const [local] = await db
    .insert(repositories)
    .values({ name: 'epochs-local', ownerId: owner.id, ingestionMethod: 'local_path', localPath: localDir })
    .returning({ id: repositories.id })
  scopes.L = local!.id
  client = new Client({ name: 'cache-epochs-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${(await mint()).token}` } } }),
  )
})

afterAll(async () => {
  setFailpointHandler(null)
  vi.restoreAllMocks()
  await client?.close()
  await settle()
  await app.close()
  if (localDir) await rm(localDir, { recursive: true, force: true })
})

describe('index_epoch: a change an answer could show bumps its own vault or repository, and nothing else (#680)', () => {
  it('note create, edit, rename, delete, restore and purge bump their vault only', async () => {
    let id = ''
    expect(
      await moved(async () => {
        id = String((await json('create_note', { vaultId: scopes.A, path: 'docs/alpha', body: 'Alpha explains the epochs.\n' })).id)
      }),
    ).toEqual(['vault:A'])
    expect(await moved(() => call('edit_note', { vaultId: scopes.A, path: 'docs/alpha', body: 'Alpha, edited.\n' }))).toEqual(['vault:A'])
    expect(await moved(() => call('rename_note', { vaultId: scopes.A, from: 'docs/alpha', toName: 'beta' }))).toEqual(['vault:A'])
    expect(await moved(() => call('delete_note', { vaultId: scopes.A, path: 'docs/beta' }))).toEqual(['vault:A'])
    expect(await moved(() => call('restore_note', { vaultId: scopes.A, noteId: id }))).toEqual(['vault:A'])
    await call('delete_note', { vaultId: scopes.A, path: 'docs/beta' })
    expect(await moved(() => call('purge_note', { vaultId: scopes.A, noteId: id }))).toEqual(['vault:A'])
    // A write to the other vault leaves this one's epoch alone.
    expect(await moved(() => call('create_note', { vaultId: scopes.B, path: 'docs/other', body: 'Elsewhere.\n' }))).toEqual(['vault:B'])
  })

  it('a revision purge bumps its vault (note_history answers change)', async () => {
    await call('create_note', { vaultId: scopes.A, path: 'docs/history', body: 'First version.\n' })
    await call('edit_note', { vaultId: scopes.A, path: 'docs/history', body: 'Second version.\n' })
    const history = (await json('note_history', { vaultId: scopes.A, path: 'docs/history' })) as { revisions: Array<{ id: string }> }
    // Newest first: the last one is the first version, which the note no longer holds.
    const oldest = history.revisions.at(-1)!.id
    expect(await moved(() => call('purge_revision', { vaultId: scopes.A, revisionId: oldest }))).toEqual(['vault:A'])
  })

  it('a collab fold bumps the vault; logged typing that is not folded yet bumps nothing', async () => {
    const id = String((await json('create_note', { vaultId: scopes.A, path: 'docs/typed', body: 'Typed later.\n' })).id)
    expect(
      await moved(async () => {
        const { state } = await loadCollabState(scopes.A, id)
        const tab = new Y.Doc()
        Y.applyUpdate(tab, state)
        const sv = Y.encodeStateVector(tab)
        tab.getText('body').insert(tab.getText('body').length, 'Acked typing.\n')
        expect(await appendCollabUpdate(scopes.A, id, Y.encodeStateAsUpdate(tab, sv), { type: 'collab' })).not.toBeNull()
      }),
    ).toEqual([])
    expect(await moved(() => foldPendingCollab([id]))).toEqual(['vault:A'])
  })

  it('embedding completion bumps the vault', async () => {
    const real = embedder.embed.bind(embedder)
    let down = true
    const spy = vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
      if (down) throw new Error('embedder down (test)')
      return real(texts)
    })
    try {
      let id = ''
      // The write's job fails its first attempt and waits for its backoff.
      expect(
        await moved(async () => {
          id = String((await json('create_note', { vaultId: scopes.A, path: 'docs/embedded', body: 'Embedded on the retry.\n' })).id)
        }),
      ).toEqual(['vault:A'])
      const [job] = await pg<Array<{ done: boolean }>>`
        SELECT done_at IS NOT NULL AS done FROM jobs WHERE kind = 'embed_note' AND payload ->> 'noteId' = ${id}`
      expect(job?.done).toBe(false)
      expect(
        await moved(async () => {
          down = false
          // The backoff ends (a claim's lease is not a change an answer shows), and a kick runs the job.
          await pg`UPDATE jobs SET lease_until = now() WHERE kind = 'embed_note' AND payload ->> 'noteId' = ${id}`
          await enqueueEmbeddings([id])
        }),
      ).toEqual(['vault:A'])
      const [after] = await pg<Array<{ done: boolean; error: string | null }>>`
        SELECT done_at IS NOT NULL AS done, last_error AS error FROM jobs WHERE kind = 'embed_note' AND payload ->> 'noteId' = ${id}`
      expect(after).toEqual({ done: true, error: null })
    } finally {
      spy.mockRestore()
    }
  })

  it('an agent push, and the extraction that completes it, bump the repository only', async () => {
    expect(await moved(() => push([{ path: 'a.ts', content: 'export const a = 1\n' }]))).toEqual(['repo:P'])
    let failing = true
    setFailpointHandler((name) => {
      if (failing && name === 'extract.before-commit') throw new FailpointError(name)
    })
    try {
      // The new content is stored; its extraction fails its first attempt.
      expect(await moved(() => push([{ path: 'a.ts', content: 'export const a = 2\nexport function b() {}\n' }]))).toEqual(['repo:P'])
      const [file] = await pg<Array<{ id: string; current: boolean }>>`
        SELECT id::text, extracted_hash IS NOT DISTINCT FROM content_hash AS current FROM repository_files WHERE repository_id = ${scopes.P} AND path = 'a.ts'`
      expect(file?.current).toBe(false)
      expect(
        await moved(async () => {
          failing = false
          await pg`UPDATE jobs SET lease_until = now() WHERE kind = 'extract' AND done_at IS NULL AND payload ->> 'fileId' = ${file!.id}`
          await enqueueExtractions([file!.id], 'never')
        }),
      ).toEqual(['repo:P'])
      const [done] = await pg<Array<{ current: boolean }>>`
        SELECT extracted_hash IS NOT DISTINCT FROM content_hash AS current FROM repository_files WHERE id = ${file!.id}`
      expect(done?.current).toBe(true)
    } finally {
      setFailpointHandler(null)
    }
  })

  it('a local-path sync bumps its repository, also when no file changed (the answer reports the sync while it runs)', async () => {
    expect(await moved(() => syncLocalRepository(scopes.L))).toEqual(['repo:L'])
    await writeFile(join(localDir, 'util.ts'), 'export const util = 2\n')
    expect(await moved(() => syncLocalRepository(scopes.L))).toEqual(['repo:L'])
    expect(await moved(() => syncLocalRepository(scopes.L))).toEqual(['repo:L'])
  })

  it('renaming a vault bumps its index epoch (answers name it), not the permission epoch', async () => {
    expect(await moved(() => call('update_vault', { vaultId: scopes.B, name: 'epochs B renamed' }))).toEqual(['vault:B'])
  })

  it('reads bump nothing: search, graph, reads, browses, lists and the token use behind each call', async () => {
    await call('create_note', { vaultId: scopes.A, path: 'docs/read-me', body: 'Read me about epochs.\n' })
    await push([{ path: 'r.ts', content: 'export function readMe() {\n  return 1\n}\n' }])
    expect(
      await moved(async () => {
        await call('search', { query: 'epochs', vaultId: scopes.A })
        await call('search', { query: 'readMe', everywhere: true })
        await call('find_symbols', { query: 'readMe', repositoryId: scopes.P })
        await call('read_note', { vaultId: scopes.A, path: 'docs/read-me' })
        await call('note_history', { vaultId: scopes.A, path: 'docs/read-me' })
        await call('browse_vault', { vaultId: scopes.A })
        await call('list_vaults', {})
        await call('graph', { vaultId: scopes.A })
        await call('graph', { repositoryId: scopes.P })
        await call('read_file', { repositoryId: scopes.P, path: 'r.ts' })
        await call('browse_repository', { repositoryId: scopes.P })
        await call('repository_status', { repositoryId: scopes.P })
        await call('list_repositories', {})
      }),
    ).toEqual([])
  })
})

describe('permission_epoch: share, team, token and account changes bump it; content writes and reads do not (#680)', () => {
  it('a vault share added and removed', async () => {
    let shareId = ''
    expect(
      await moved(async () => {
        shareId = String((await json('share_vault', { vaultId: scopes.A, granteeType: 'user', granteeId: otherUserId, permission: 'read' })).id)
      }),
    ).toEqual(['permission'])
    expect(await moved(() => call('revoke_vault_share', { vaultId: scopes.A, shareId }))).toEqual(['permission'])
  })

  it('a repository share added and removed', async () => {
    let shareId = ''
    expect(
      await moved(async () => {
        shareId = String((await json('share_repository', { repositoryId: scopes.P, granteeType: 'user', granteeId: otherUserId })).id)
      }),
    ).toEqual(['permission'])
    expect(await moved(() => call('revoke_repository_share', { repositoryId: scopes.P, shareId }))).toEqual(['permission'])
  })

  it('a team created, a member added and removed', async () => {
    let teamId = ''
    expect(
      await moved(async () => {
        teamId = String((await json('create_team', { name: 'epochs team' })).id)
      }),
    ).toEqual(['permission'])
    expect(await moved(() => call('add_team_member', { teamId, userId: otherUserId }))).toEqual(['permission'])
    expect(await moved(() => call('remove_team_member', { teamId, userId: otherUserId }))).toEqual(['permission'])
  })

  it('a token minted and revoked', async () => {
    let id = ''
    expect(
      await moved(async () => {
        id = (await mint()).id
      }),
    ).toEqual(['permission'])
    expect(
      await moved(async () => {
        const res = await app.inject({ method: 'POST', url: `/api/mcp-connections/${id}/revoke`, headers: { cookie } })
        expect(res.statusCode).toBe(200)
      }),
    ).toEqual(['permission'])
  })

  it('a user deactivated by an admin', async () => {
    const admin = await createActiveUser({ role: 'admin' })
    const adminCookie = await loginCookie(app, admin.email)
    const target = await createActiveUser()
    expect(
      await moved(async () => {
        const res = await app.inject({ method: 'POST', url: `/api/admin/users/${target.id}/deactivate`, headers: { cookie: adminCookie } })
        expect(res.statusCode).toBe(200)
      }),
    ).toEqual(['permission'])
  })
})
