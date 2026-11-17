// #677/#1087: real Git smart-HTTP clone/edit/push, live collaborative edits, bounded failures and explicit purge.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile, fork, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename as renameFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { setTimeout as sleep } from 'node:timers/promises'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { and, eq, sql } from 'drizzle-orm'
import { existsSync, watch } from 'node:fs'
import { db } from '../src/db/client.js'
import { mcpConnections, noteRevisions, vaultGitPushOperations, vaultGitSnapshots, vaults } from '../src/db/schema.js'
import { sweepVaultRemotes, vaultRemoteDir } from '../src/git-remote/vault-remote.js'
import { assetFile, createNote, getBaseRevision, getLiveNote, purgeNote, purgeRevision, readAsset, readLiveNote, renameNote, softDeleteNote, updateNote, writeAsset } from '../src/notes/store.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { setFailpointHandler } from '../src/failpoints.js'
import { purgeVaultRecord } from '../src/vaults/routes.js'
import type * as FsPromises from 'node:fs/promises'
import type * as GitMetadata from '../src/git-remote/metadata.js'
import type * as NoteProjector from '../src/notes/projector.js'
import { config } from '../src/config.js'
import { assetBlobId } from '../src/notes/store.js'
import { GIT_QUOTAS, loadManifest, operationResults } from '../src/git-remote/metadata.js'
import { assetGitPath, assetNameFromGitPath, type Manifest } from '../src/git-remote/tree.js'
import { boundedGit, PACK_LIMITS, withGitBudget } from '../src/git-remote/pack.js'

// setup-jobs imports the projector/atomic-write before test mocks; reload those modules
// so the instrumentation observes real filesystem calls in the actual store path.
vi.hoisted(() => vi.resetModules())
// Instrument the real filesystem and real database receipt, rather than substitute a successful mutation.
const durability = vi.hoisted(() => ({ enabled: false, file: '', directory: '', vaultId: '', failDirectorySync: false, events: [] as string[] }))
const boundary = vi.hoisted(() => ({
  failReceipt: '',
  mapVault: '',
  afterMapped: null as null | (() => Promise<void>),
  renameTarget: '',
  beforeAssetRename: null as null | (() => Promise<void>),
  countRenders: false,
  renders: 0,
}))
vi.mock('../src/notes/projector.js', async (importOriginal) => {
  const real = await importOriginal<typeof NoteProjector>()
  return {
    ...real,
    renderNoteFile: (...args: Parameters<typeof real.renderNoteFile>) => {
      if (boundary.countRenders) boundary.renders++
      return real.renderNoteFile(...args)
    },
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>()
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      const name = String(args[0])
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (durability.enabled) {
          if (name === durability.directory) {
            durability.events.push('directory-sync')
            if (durability.failDirectorySync) {
              durability.failDirectorySync = false
              throw new Error('injected failure before durable directory sync')
            }
          } else if (name === durability.file || name.startsWith(durability.file + '.') || name.startsWith(durability.directory + '/.atomic..')) durability.events.push('file-sync')
        }
        await sync()
      }
      return handle
    },
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (String(args[1]) === boundary.renameTarget) await boundary.beforeAssetRename?.()
      if (durability.enabled && String(args[1]) === durability.file) durability.events.push('rename')
      return real.rename(...args)
    },
    rm: async (...args: Parameters<typeof real.rm>) => {
      if (durability.enabled && String(args[0]) === durability.file) durability.events.push('unlink')
      return real.rm(...args)
    },
  }
})
vi.mock('../src/git-remote/metadata.js', async (importOriginal) => {
  const real = await importOriginal<typeof GitMetadata>()
  return {
    ...real,
    saveManifest: async (...args: Parameters<typeof real.saveManifest>) => {
      await real.saveManifest(...args)
      if (args[0] === boundary.mapVault) await boundary.afterMapped?.()
    },
    recordOperation: async (...args: Parameters<typeof real.recordOperation>) => {
      if (boundary.failReceipt === `${args[1]}:${args[4]}`) {
        boundary.failReceipt = ''
        throw new Error('injected loss after proposal durability and before operation receipt')
      }
      await real.recordOperation(...args)
      if (durability.enabled && args[1] === durability.vaultId && args[4] === '.assets/proof.txt' && args[5].status === 'applied') durability.events.push('receipt')
    },
  }
})

const sh = promisify(execFile)
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir() }

let app: FastifyInstance
let baseUrl: string
let cookie: string
let vaultId: string
let otherVaultId: string
const dirs: string[] = []
let collab: CollabRelay
let ownerToken: string
const providers: HocuspocusProvider[] = []
const gitErrors: string[] = []
const bodySeen = new Set<string>()
const bodyAborted = new Set<string>()

async function mint(body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body })
  expect(res.statusCode, res.body).toBe(200)
  return res.json<{ token: string }>().token
}

async function git(args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await sh('git', ['-c', 'credential.helper=', ...args], { cwd, env: GIT_ENV, timeout: 30_000 })
    return { ok: true, out: r.stdout + r.stderr }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, out: (e.stdout ?? '') + (e.stderr ?? '') + (gitErrors.at(-1) ?? '') }
  }
}

/** `git clone` of the vault with `token` as the password: the clone's directory, or the failure text. */
async function clone(token: string, id = vaultId): Promise<{ dir: string; ok: boolean; out: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'vault-clone-'))
  dirs.push(dir)
  const url = baseUrl.replace('http://', `http://elara:${token}@`) + `/git/vaults/${id}`
  return { dir, ...(await git(['clone', '--quiet', url, dir])) }
}

beforeAll(async () => {
  app = await buildApp()
  app.addHook('preParsing', async (req, _reply, payload) => {
    const marker = req.headers['x-git-body-proof']
    if (typeof marker === 'string') bodySeen.add(marker)
    return payload
  })
  app.addHook('onRequestAbort', async req => {
    const marker = req.headers['x-git-body-proof']
    if (typeof marker === 'string') bodyAborted.add(marker)
  })
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.endsWith('/git-receive-pack') && reply.statusCode >= 400 && typeof payload === 'string') gitErrors.push(payload)
    return payload
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  ownerToken = await loginToken(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'git remote vault' } })).json<{ id: string }>().id
  otherVaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'other vault' } })).json<{ id: string }>().id
  await createNote(vaultId, { path: 'docs/alpha', frontmatter: { title: 'Alpha' }, body: 'The alpha note mentions pelicans.\n' })
  await createNote(vaultId, { path: 'beta', body: 'Beta is about herons.\n' })
  await createNote(otherVaultId, { path: 'secret', body: 'The other vault holds albatross plans.\n' })
}, 60_000)

afterAll(async () => {
  providers.forEach((provider) => {
    const document = provider.document
    provider.destroy()
    document.destroy()
  })
  await collab?.destroy()
  await app?.close()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

describe('a vault is an authenticated git remote (#677/#1087)', () => {
  it('clones the notes as files, with their frontmatter, for an account token', async () => {
    const token = await mint({ name: 'git-account', scope: 'account', access: 'read' })
    const c = await clone(token)
    expect(c.ok, c.out).toBe(true)
    expect(await readFile(join(c.dir, 'docs/alpha.md'), 'utf8')).toContain('pelicans')
    expect(await readFile(join(c.dir, 'docs/alpha.md'), 'utf8')).toMatch(/^---\n[\s\S]*title: Alpha/)
    expect(await readFile(join(c.dir, 'beta.md'), 'utf8')).toContain('herons')
    // Grep locally, the point of the remote.
    expect((await git(['grep', '-l', 'pelicans'], c.dir)).out.trim()).toBe('docs/alpha.md')
  })

  it('a vault-pinned token clones its vault and is refused any other; the pin never widens', async () => {
    const token = await mint({ name: 'git-pinned', scope: 'vault', vaultId })
    expect((await clone(token)).ok).toBe(true)
    const other = await clone(token, otherVaultId)
    expect(other.ok).toBe(false)
    expect(other.out).not.toContain('albatross')
  })

  it('refuses a repository-pinned token, a missing or malformed vault and unknown credentials', async () => {
    const repo = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'git-remote-repo', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
    const repoToken = await mint({ name: 'git-repo-pin', scope: 'repository', repositoryId: repo })
    expect((await clone(repoToken)).ok).toBe(false)
    const token = await mint({ name: 'git-missing', scope: 'account', access: 'read' })
    expect((await clone(token, '00000000-0000-4000-8000-000000000000')).ok).toBe(false)
    expect((await clone(token, 'not-a-uuid')).ok).toBe(false)
    expect((await clone('elara_wrong')).ok).toBe(false)
    const anonymous = await app.inject({ method: 'GET', url: `/git/vaults/${vaultId}/info/refs?service=git-upload-pack` })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.headers['www-authenticate']).toMatch(/^Basic/)
  })

  it('a revoked token and an allow-list without read_note are refused', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'git-revoked', scope: 'account', access: 'read' } })
    const { token, id } = created.json<{ token: string; id: string }>()
    expect((await clone(token)).ok).toBe(true)
    expect((await app.inject({ method: 'POST', url: `/api/mcp-connections/${id}/revoke`, headers: { cookie } })).statusCode).toBeLessThan(300)
    expect((await clone(token)).ok).toBe(false)
    const listed = await mint({ name: 'git-allow', scope: 'account', access: 'read', allowedTools: ['search'] })
    expect((await clone(listed)).ok).toBe(false)
  })

  it('a read token cannot push, on advertisement or a direct pack POST', async () => {
    const token = await mint({ name: 'git-read-only', scope: 'account', access: 'read' })
    const refused = await app.inject({ method: 'GET', url: `/git/vaults/${vaultId}/info/refs?service=git-receive-pack`, headers: { authorization: `Bearer ${token}` } })
    expect(refused.statusCode).toBe(403)
    const direct = await app.inject({ method: 'POST', url: `/git/vaults/${vaultId}/git-receive-pack`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-git-receive-pack-request' }, payload: Buffer.from('not a pack') })
    expect(direct.statusCode).toBe(403)
    const c = await clone(token)
    expect(c.ok, c.out).toBe(true)
    await git(['config', 'user.email', 'a@b.c'], c.dir)
    await git(['config', 'user.name', 'a'], c.dir)
    await sh('sh', ['-c', 'echo pushed > pushed.md && git add -A && git commit -qm x'], { cwd: c.dir, env: GIT_ENV })
    expect((await git(['push', 'origin', 'HEAD:main'], c.dir)).ok).toBe(false)
    expect((await clone(token)).ok).toBe(true)
    const again = await clone(token)
    await expect(readFile(join(again.dir, 'pushed.md'), 'utf8')).rejects.toThrow()
  })

  it('ordinary edits fast-forward real history; explicit revision purge synchronously removes all server Git objects', async () => {
    const token = await mint({ name: 'git-fetch', scope: 'account', access: 'read' })
    const c = await clone(token)
    expect(c.ok, c.out).toBe(true)
    const previous = await readLiveNote(vaultId, 'beta')
    const revision = await getBaseRevision(vaultId, 'beta', previous!.row.seq)
    const head = (await git(['rev-parse', 'HEAD'], c.dir)).out.trim()
    const oldBlob = (await git(['rev-parse', 'HEAD:beta.md'], c.dir)).out.trim()
    await updateNote(vaultId, 'beta', { body: 'Beta is about storks now.\n' })
    const pull = await git(['pull', '--quiet', '--ff-only'], c.dir)
    expect(pull.ok, pull.out).toBe(true)
    expect((await git(['merge-base', '--is-ancestor', head, 'HEAD'], c.dir)).ok).toBe(true)
    expect((await git(['cat-file', '-e', oldBlob], vaultRemoteDir(vaultId))).ok).toBe(true)
    expect(await purgeRevision(vaultId, revision!.id)).toBe(true)
    expect(existsSync(vaultRemoteDir(vaultId))).toBe(false)
    const clean = await clone(token)
    expect(clean.ok, clean.out).toBe(true)
    expect((await git(['cat-file', '-e', oldBlob], vaultRemoteDir(vaultId))).ok).toBe(false)
    expect((await git(['cat-file', '-e', head], vaultRemoteDir(vaultId))).ok).toBe(false)
    // Already downloaded clones are explicitly outside server erasure control.
    expect((await git(['cat-file', '-e', oldBlob], c.dir)).ok).toBe(true)
    expect(await readFile(join(clean.dir, 'beta.md'), 'utf8')).toContain('storks')
  })

  it('`git pull --rebase` of an unmodified clone moves it to the new snapshot', async () => {
    const token = await mint({ name: 'git-rebase', scope: 'account', access: 'read' })
    const c = await clone(token)
    expect(c.ok, c.out).toBe(true)
    await git(['config', 'user.email', 'a@b.c'], c.dir)
    await git(['config', 'user.name', 'a'], c.dir)
    await createNote(vaultId, { path: 'gamma', body: 'Gamma is about cranes.\n' })
    const pull = await git(['pull', '--rebase', '--quiet'], c.dir)
    expect(pull.ok, pull.out).toBe(true)
    expect(await readFile(join(c.dir, 'gamma.md'), 'utf8')).toContain('cranes')
    expect((await git(['status', '--porcelain'], c.dir)).out.trim()).toBe('')
  })

  it('the Bearer header form (http.extraHeader, no userinfo in the URL) clones, and a body that is not a pkt-line request is a 400', async () => {
    const token = await mint({ name: 'git-header', scope: 'account', access: 'read' })
    const dir = await mkdtemp(join(tmpdir(), 'vault-clone-'))
    dirs.push(dir)
    const cloned = await git(['-c', `http.extraHeader=Authorization: Bearer ${token}`, 'clone', '--quiet', `${baseUrl}/git/vaults/${vaultId}`, dir])
    expect(cloned.ok, cloned.out).toBe(true)
    expect(await readFile(join(dir, 'beta.md'), 'utf8')).toContain('Beta')
    const bad = await app.inject({ method: 'POST', url: `/git/vaults/${vaultId}/git-upload-pack`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-git-upload-pack-request' }, payload: Buffer.from('this is not pkt-line') })
    expect(bad.statusCode).toBe(400)
  })

  it('refuses a gzip bomb and an oversized or malformed request without inflating it', async () => {
    const token = await mint({ name: 'git-bomb', scope: 'account', access: 'read' })
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/x-git-upload-pack-request', 'content-encoding': 'gzip' }
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024))
    expect(bomb.length).toBeLessThan(200_000)
    const res = await app.inject({ method: 'POST', url: `/git/vaults/${vaultId}/git-upload-pack`, headers, payload: bomb })
    expect(res.statusCode).toBe(413)
    const bad = await app.inject({ method: 'POST', url: `/git/vaults/${vaultId}/git-upload-pack`, headers, payload: Buffer.from('not gzip') })
    expect(bad.statusCode).toBe(413)
    const big = await app.inject({ method: 'POST', url: `/git/vaults/${vaultId}/git-upload-pack`, headers: { ...headers, 'content-encoding': 'identity' }, payload: Buffer.alloc(2 * 1024 * 1024) })
    expect(big.statusCode).toBe(413)
  })

  it('a deleted note is gone from the next fetch, and the repository of a deleted vault is swept', async () => {
    const token = await mint({ name: 'git-delete', scope: 'account', access: 'read' })
    const id = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'short-lived' } })).json<{ id: string }>().id
    await createNote(id, { path: 'keep', body: 'kept\n' })
    await createNote(id, { path: 'drop', body: 'dropped\n' })
    const c = await clone(token, id)
    expect(c.ok, c.out).toBe(true)
    await softDeleteNote(id, 'drop')
    expect((await git(['fetch', '--quiet', 'origin'], c.dir)).ok).toBe(true)
    expect((await git(['reset', '--quiet', '--hard', 'origin/main'], c.dir)).ok).toBe(true)
    expect((await git(['ls-files'], c.dir)).out.trim()).toBe('keep.md')

    expect(existsSync(vaultRemoteDir(id))).toBe(true)
    await db.delete(vaults).where(eq(vaults.id, id))
    expect(await sweepVaultRemotes()).toBeGreaterThanOrEqual(1)
    expect(existsSync(vaultRemoteDir(id))).toBe(false)
  })
})

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for real Git/relay acknowledgement')
    await sleep(10)
  }
}

async function pushFixture() {
  const id = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'push proof' } })).json<{ id: string }>().id
  const a = await createNote(id, { path: 'docs/a', body: 'First line.\nMiddle line.\nLast line.\n' })
  await createNote(id, { path: 'docs/b', body: 'Another first.\nAnother last.\n' })
  await writeAsset(id, 'proof.txt', Buffer.from('base asset'))
  const token = await mint({ name: 'git-push-proof', scope: 'vault', vaultId: id, access: 'write', profile: 'admin' })
  const c = await clone(token, id)
  expect(c.ok, c.out).toBe(true)
  await git(['config', 'user.email', 'git-proof@localhost'], c.dir)
  await git(['config', 'user.name', 'Git proof'], c.dir)
  return { id, a, token, dir: c.dir }
}

async function commit(dir: string) {
  expect((await git(['add', '-A'], dir)).ok).toBe(true)
  const result = await git(['commit', '-qm', 'vault edit'], dir)
  expect(result.ok, result.out).toBe(true)
  return (await git(['rev-parse', 'HEAD'], dir)).out.trim()
}

async function editFile(dir: string, path: string, from: string, to: string) {
  const file = join(dir, path)
  const before = await readFile(file, 'utf8')
  expect(before).toContain(from)
  await writeFile(file, before.replace(from, to))
}

async function human(id: string, noteId: string) {
  const provider = new HocuspocusProvider({ url: baseUrl.replace('http', 'ws') + '/collab', name: `${id}/~${noteId}`, token: ownerToken, document: new Y.Doc() })
  providers.push(provider)
  const text = provider.document.getText('body')
  await waitFor(() => provider.isSynced && text.length > 0)
  return { provider, text }
}

describe('safe writable vault round trips (#677/#1087)', () => {
  it('keeps actual incoming OIDs through status, next fetch and a second push; creates/deletes notes and replaces/removes assets', async () => {
    const f = await pushFixture()
    await editFile(f.dir, 'docs/a.md', 'Middle line.', 'Agent middle.')
    await writeFile(join(f.dir, '.assets/proof.txt'), 'replacement asset')
    const first = await commit(f.dir)
    const pushed = await git(['push', 'origin', 'HEAD:main'], f.dir)
    expect(pushed.ok, pushed.out).toBe(true)
    expect((await git(['ls-remote', 'origin', 'refs/heads/main'], f.dir)).out.split(/\s/)[0]).toBe(first)
    expect((await git(['fetch', 'origin'], f.dir)).ok).toBe(true)
    expect((await git(['rev-parse', 'origin/main'], f.dir)).out.trim()).toBe(first)
    expect((await readLiveNote(f.id, 'docs/a'))!.body).toContain('Agent middle.')
    expect((await readAsset(f.id, 'proof.txt'))!.buffer.toString()).toBe('replacement asset')
    await writeFile(join(f.dir, 'docs/new.md'), '---\ntype: docs\ntitle: New\n---\nNewly pushed note.\n')
    await rm(join(f.dir, 'docs/b.md'))
    await rm(join(f.dir, '.assets/proof.txt'))
    const second = await commit(f.dir)
    const again = await git(['push', 'origin', 'HEAD:main'], f.dir)
    expect(again.ok, again.out).toBe(true)
    expect((await git(['ls-remote', 'origin', 'refs/heads/main'], f.dir)).out.split(/\s/)[0]).toBe(second)
    expect((await readLiveNote(f.id, 'docs/new'))!.body).toBe('Newly pushed note.\n')
    expect(await getLiveNote(f.id, 'docs/b')).toBeNull()
    expect(await readAsset(f.id, 'proof.txt')).toBeNull()
  }, 30_000)

  it('merges a real browser document edited while real Git push is in flight, then fetch/pull and the next push fast-forward normally', async () => {
    const f = await pushFixture()
    const tab = await human(f.id, f.a.id)
    await editFile(f.dir, 'docs/a.md', 'Middle line.', 'Agent middle.')
    const pushedOid = await commit(f.dir)
    // Git runs pre-push after discovery. Hold the real client there while the person types and gets a durable relay ACK.
    const hooks = join(f.dir, '.git', 'hooks')
    await mkdir(hooks, { recursive: true })
    await writeFile(join(hooks, 'pre-push'), '#!/bin/sh\ntouch .git/push-ready\ni=0\nwhile [ ! -f .git/push-release ] && [ \"$i\" -lt 1000 ]; do sleep 0.01; i=$((i+1)); done\ntest -f .git/push-release\n', { mode: 0o700 })
    const push = git(['push', 'origin', 'HEAD:main'], f.dir)
    await waitFor(() => existsSync(join(f.dir, '.git/push-ready')))
    tab.text.insert(0, 'Human leading line.\n')
    await waitFor(() => !tab.provider.hasUnsyncedChanges)
    await writeFile(join(f.dir, '.git/push-release'), '')
    tab.text.insert(tab.text.length, 'Human trailing line.\n')
    await waitFor(() => !tab.provider.hasUnsyncedChanges)
    const result = await push
    expect(result.ok, result.out).toBe(true)
    const live = (await readLiveNote(f.id, 'docs/a'))!.body
    expect(live).toBe('Human leading line.\nFirst line.\nAgent middle.\nLast line.\nHuman trailing line.\n')
    await waitFor(() => tab.text.toString() === live)
    const pull = await git(['pull', '--ff-only', 'origin', 'main'], f.dir)
    expect(pull.ok, pull.out).toBe(true)
    expect((await git(['merge-base', '--is-ancestor', pushedOid, 'HEAD'], f.dir)).ok).toBe(true)
    expect(await readFile(join(f.dir, 'docs/a.md'), 'utf8')).toContain(live)
    await editFile(f.dir, 'docs/a.md', 'Agent middle.', 'Second agent middle.')
    await commit(f.dir)
    const second = await git(['push', 'origin', 'HEAD:main'], f.dir)
    expect(second.ok, second.out).toBe(true)
    expect((await readLiveNote(f.id, 'docs/a'))!.body).toContain('Human trailing line.')
  }, 30_000)

  it('keeps overlaps as persistent, reachable proposals; multi-note NG and retry never overwrite later typing in an already applied note', async () => {
    const f = await pushFixture()
    const tab = await human(f.id, f.a.id)
    await editFile(f.dir, 'docs/a.md', 'First line.', 'Agent first.')
    await editFile(f.dir, 'docs/b.md', 'Another first.', 'Agent other first.')
    const oid = await commit(f.dir)
    tab.text.delete(0, 'First line.'.length)
    tab.text.insert(0, 'Human first.')
    await waitFor(() => !tab.provider.hasUnsyncedChanges)
    const failed = await git(['push', 'origin', 'HEAD:main'], f.dir)
    expect(failed.ok, failed.out).toBe(false)
    expect(failed.out).toContain('non-atomic')
    const report = await app.inject({ method: 'GET', url: `/git/vaults/${f.id}/pushes/${oid}`, headers: { authorization: `Bearer ${f.token}` } })
    expect(report.statusCode, report.body).toBe(200)
    const operations = report.json<{ operations: Array<{ path: string; result: { status: string; proposalId?: string } }> }>().operations
    const proposal = operations.find((entry) => entry.path === 'docs/a.md')!.result
    expect(proposal.status).toBe('conflicted')
    expect(operations.find((entry) => entry.path === 'docs/b.md')!.result.status).toBe('applied')
    const preview = await app.inject({ method: 'GET', url: `/git/vaults/${f.id}/pushes/${oid}/proposals/${proposal.proposalId}`, headers: { authorization: `Bearer ${f.token}` } })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json<{ body: string }>().body).toContain('Agent first.')
    expect((await readLiveNote(f.id, 'docs/a'))!.body).toContain('Human first.')
    await updateNote(f.id, 'docs/b', { body: 'Human edited the already applied second note.\n' })
    expect((await git(['push', 'origin', 'HEAD:main'], f.dir)).ok).toBe(false)
    expect((await readLiveNote(f.id, 'docs/b'))!.body).toBe('Human edited the already applied second note.\n')
  }, 30_000)

  it('resumes an interrupted multi-note import without replaying its committed operation over a person', async () => {
    const f = await pushFixture()
    await editFile(f.dir, 'docs/a.md', 'Middle line.', 'Agent middle.')
    await editFile(f.dir, 'docs/b.md', 'Another first.', 'Agent other first.')
    await commit(f.dir)
    let writes = 0
    setFailpointHandler((name) => { if (name === 'edit.before-commit' && ++writes === 2) throw new Error('injected second-note failure') })
    try {
      const failed = await git(['push', 'origin', 'HEAD:main'], f.dir)
      expect(failed.ok, failed.out).toBe(false)
    } finally { setFailpointHandler(null) }
    expect((await readLiveNote(f.id, 'docs/a'))!.body).toContain('Agent middle.')
    expect((await readLiveNote(f.id, 'docs/b'))!.body).not.toContain('Agent other first.')
    await updateNote(f.id, 'docs/a', { body: 'Person after the first committed import operation.\n' })
    const resumed = await git(['push', 'origin', 'HEAD:main'], f.dir)
    expect(resumed.ok, resumed.out).toBe(true)
    expect((await readLiveNote(f.id, 'docs/a'))!.body).toBe('Person after the first committed import operation.\n')
    expect((await readLiveNote(f.id, 'docs/b'))!.body).toContain('Agent other first.')
  }, 30_000)

  it('validates the complete real tree before writes and makes asset conflicts downloadable without clobbering the live asset', async () => {
    const unsafe = await pushFixture()
    await editFile(unsafe.dir, 'docs/a.md', 'Middle line.', 'Should not be applied.')
    await symlink('/etc/passwd', join(unsafe.dir, 'docs/link.md'))
    await commit(unsafe.dir)
    const rejected = await git(['push', 'origin', 'HEAD:main'], unsafe.dir)
    expect(rejected.ok, rejected.out).toBe(false)
    expect((await readLiveNote(unsafe.id, 'docs/a'))!.body).not.toContain('Should not be applied.')
    const f = await pushFixture()
    await writeFile(join(f.dir, '.assets/proof.txt'), 'agent asset version')
    const oid = await commit(f.dir)
    await writeAsset(f.id, 'proof.txt', Buffer.from('new human asset version'))
    const conflict = await git(['push', 'origin', 'HEAD:main'], f.dir)
    expect(conflict.ok, conflict.out).toBe(false)
    expect((await readAsset(f.id, 'proof.txt'))!.buffer.toString()).toBe('new human asset version')
    const proposed = await app.inject({ method: 'GET', url: `/git/vaults/${f.id}/pushes/${oid}/assets/proof.txt`, headers: { authorization: `Bearer ${f.token}` } })
    expect(proposed.statusCode).toBe(200)
    expect(proposed.body).toBe('agent asset version')
    expect(proposed.headers['content-disposition']).toContain('attachment')
  }, 30_000)

  it('purges a renamed note and its historical Git paths, and removes a purged vault remote synchronously', async () => {
    const f = await pushFixture()
    const oldBlob = (await git(['rev-parse', 'HEAD:docs/a.md'], f.dir)).out.trim()
    await renameNote(f.id, 'docs/a', 'docs/renamed')
    expect((await clone(f.token, f.id)).ok).toBe(true)
    await softDeleteNote(f.id, 'docs/renamed')
    expect(await purgeNote(f.id, f.a.id)).toBe(true)
    expect(existsSync(vaultRemoteDir(f.id))).toBe(false)
    const clean = await clone(f.token, f.id)
    expect(clean.ok, clean.out).toBe(true)
    expect((await git(['cat-file', '-e', oldBlob], vaultRemoteDir(f.id))).ok).toBe(false)
    await purgeVaultRecord(f.id)
    expect(existsSync(vaultRemoteDir(f.id))).toBe(false)
  }, 30_000)
})

describe('push access and pin matrix', () => {
  it('refuses repository/wrong-vault pins, missing write/profile/edit permission, revoked shares and operation allow-list widening', async () => {
    const f = await pushFixture()
    const repo = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'push-pin-repo', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
    const repoToken = await mint({ name: 'push-repo-pin', scope: 'repository', repositoryId: repo, access: 'write' })
    const readerProfile = await mint({ name: 'push-reader-profile', scope: 'account', access: 'write', profile: 'reader' })
    for (const [token, target, expected] of [[repoToken, f.id, 404], [f.token, otherVaultId, 404], [readerProfile, f.id, 403]] as const) {
      for (const method of ['GET', 'POST'] as const) {
        const url = method === 'GET' ? `/git/vaults/${target}/info/refs?service=git-receive-pack` : `/git/vaults/${target}/git-receive-pack`
        const response = await app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/x-git-receive-pack-request' } : {}) }, ...(method === 'POST' ? { payload: Buffer.from('not a pack') } : {}) })
        expect(response.statusCode, response.body).toBe(expected)
      }
    }
    const shared = await createActiveUser()
    const sharedCookie = await loginCookie(app, shared.email)
    const token = (await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie: sharedCookie }, body: { name: 'push-shared', scope: 'account', access: 'write' } })).json<{ token: string }>().token
    const share = await app.inject({ method: 'POST', url: `/api/vaults/${f.id}/shares`, headers: { cookie }, body: { granteeType: 'user', granteeId: shared.id, permission: 'read' } })
    const headers = { authorization: `Bearer ${token}` }
    expect((await app.inject({ method: 'GET', url: `/git/vaults/${f.id}/info/refs?service=git-receive-pack`, headers })).statusCode).toBe(403)
    await app.inject({ method: 'DELETE', url: `/api/vaults/${f.id}/shares/${share.json<{ id: string }>().id}`, headers: { cookie } })
    const editable = await app.inject({ method: 'POST', url: `/api/vaults/${f.id}/shares`, headers: { cookie }, body: { granteeType: 'user', granteeId: shared.id, permission: 'edit' } })
    expect((await app.inject({ method: 'GET', url: `/git/vaults/${f.id}/info/refs?service=git-receive-pack`, headers })).statusCode).toBe(200)
    await app.inject({ method: 'DELETE', url: `/api/vaults/${f.id}/shares/${editable.json<{ id: string }>().id}`, headers: { cookie } })
    expect((await app.inject({ method: 'POST', url: `/git/vaults/${f.id}/git-receive-pack`, headers: { ...headers, 'content-type': 'application/x-git-receive-pack-request' }, payload: Buffer.from('not a pack') })).statusCode).toBe(404)
    const limited = await mint({ name: 'push-operation-limit', scope: 'vault', vaultId: f.id, access: 'write', allowedTools: ['read_note', 'edit_note'] })
    await writeFile(join(f.dir, 'docs/forbidden.md'), '---\ntype: docs\n---\nMust not be created.\n')
    await commit(f.dir)
    const denied = await git(['-c', `http.extraHeader=Authorization: Bearer ${limited}`, 'push', `${baseUrl}/git/vaults/${f.id}`, 'HEAD:main'], f.dir)
    expect(denied.ok, denied.out).toBe(false)
    expect(await getLiveNote(f.id, 'docs/forbidden')).toBeNull()
  }, 30_000)
})

it('purging an old revision evicts live CRDT history while preserving every acknowledged human update for reconnect', async () => {
  const f = await pushFixture()
  await updateNote(f.id, 'docs/a', { body: 'Old secret that is deliberately purged.\n' })
  const old = await readLiveNote(f.id, 'docs/a')
  const revision = await getBaseRevision(f.id, 'docs/a', old!.row.seq)
  await updateNote(f.id, 'docs/a', { body: 'Current clean body.\n' })
  const tab = await human(f.id, f.a.id)
  tab.text.insert(tab.text.length, 'Acknowledged human typing before purge.\n')
  await waitFor(() => !tab.provider.hasUnsyncedChanges)
  expect(await purgeRevision(f.id, revision!.id)).toBe(true)
  expect(collab.hocuspocus.documents.has(`${f.id}/~${f.a.id}`)).toBe(false)
  const reconnected = await human(f.id, f.a.id)
  expect(reconnected.text.toString()).toBe('Current clean body.\nAcknowledged human typing before purge.\n')
  expect((await readLiveNote(f.id, 'docs/a'))!.body).toBe(reconnected.text.toString())
}, 30_000)

it('keeps valid assets/ note identities and nested notes disjoint from attachments across edit/delete/fetch/second push', async () => {
  const f = await pushFixture()
  const design = await createNote(f.id, { path: 'assets/design', body: 'This is a note, not an attachment.\n' })
  await createNote(f.id, { path: 'assets/design/overview', body: 'A valid nested note under assets.\n' })
  await writeAsset(f.id, 'design.md', Buffer.from('Independent attachment bytes'))
  const c = await clone(f.token, f.id)
  expect(c.ok, c.out).toBe(true)
  await git(['config', 'user.email', 'git-proof@localhost'], c.dir)
  await git(['config', 'user.name', 'Git proof'], c.dir)
  expect(await readFile(join(c.dir, 'assets/design.md'), 'utf8')).toContain('This is a note')
  expect(await readFile(join(c.dir, '.assets/design.md'), 'utf8')).toBe('Independent attachment bytes')
  expect(await readFile(join(c.dir, 'assets/design/overview.md'), 'utf8')).toContain('valid nested note')
  await editFile(c.dir, 'assets/design.md', 'This is a note', 'Edited note')
  await editFile(c.dir, 'docs/a.md', 'Middle line.', 'Another unrelated edit.')
  await commit(c.dir)
  expect((await git(['rev-parse', 'refs/heads/main'], vaultRemoteDir(f.id))).out.trim()).toBe((await git(['rev-parse', 'HEAD^'], c.dir)).out.trim())
  const first = await git(['push', 'origin', 'HEAD:main'], c.dir)
  expect(first.ok, first.out).toBe(true)
  expect((await getLiveNote(f.id, 'assets/design'))!.id).toBe(design.id)
  expect((await readLiveNote(f.id, 'assets/design'))!.body).toContain('Edited note')
  expect((await readAsset(f.id, 'design.md'))!.buffer.toString()).toBe('Independent attachment bytes')
  await rm(join(c.dir, 'assets/design.md'))
  await writeFile(join(c.dir, '.assets/design.md'), 'Replacement attachment bytes')
  const secondOid = await commit(c.dir)
  const limited = await mint({ name: 'note-delete-is-not-asset-edit', scope: 'vault', vaultId: f.id, access: 'write', allowedTools: ['read_note', 'edit_note'] })
  expect((await git(['-c', `http.extraHeader=Authorization: Bearer ${limited}`, 'push', `${baseUrl}/git/vaults/${f.id}`, 'HEAD:main'], c.dir)).ok).toBe(false)
  expect((await getLiveNote(f.id, 'assets/design'))!.id).toBe(design.id)
  expect((await readAsset(f.id, 'design.md'))!.buffer.toString()).toBe('Independent attachment bytes')
  const second = await git(['push', 'origin', 'HEAD:main'], c.dir)
  expect(second.ok, second.out).toBe(true)
  expect(await getLiveNote(f.id, 'assets/design')).toBeNull()
  expect((await readAsset(f.id, 'design.md'))!.buffer.toString()).toBe('Replacement attachment bytes')
  expect((await git(['fetch', 'origin'], c.dir)).ok).toBe(true)
  expect((await git(['merge-base', '--is-ancestor', secondOid, 'origin/main'], c.dir)).ok).toBe(true)
  expect((await readLiveNote(f.id, 'assets/design/overview'))!.body).toContain('valid nested note')
}, 30_000)

it('synchronizes real attachment replacement/deletion before the durable receipt and Git acknowledgement', async () => {
  const f = await pushFixture()
  Object.assign(durability, { enabled: true, file: assetFile(f.id, 'proof.txt'), directory: assetFile(f.id, ''), vaultId: f.id, events: [] })
  try {
    await writeFile(join(f.dir, '.assets/proof.txt'), 'Durable replacement.')
    await commit(f.dir)
    const replacement = await git(['push', 'origin', 'HEAD:main'], f.dir)
    durability.events.push('ack')
    expect(replacement.ok, replacement.out).toBe(true)
    expect(durability.events).toEqual(['file-sync', 'rename', 'directory-sync', 'receipt', 'ack'])
    durability.events.length = 0
    await rm(join(f.dir, '.assets/proof.txt'))
    await commit(f.dir)
    const deletion = await git(['push', 'origin', 'HEAD:main'], f.dir)
    durability.events.push('ack')
    expect(deletion.ok, deletion.out).toBe(true)
    expect(durability.events).toEqual(['unlink', 'directory-sync', 'receipt', 'ack'])
  } finally { durability.enabled = false }
}, 30_000)

it('does not acknowledge a failed directory sync; a verified-byte retry completes durability before recording its receipt', async () => {
  const f = await pushFixture()
  Object.assign(durability, { enabled: true, file: assetFile(f.id, 'proof.txt'), directory: assetFile(f.id, ''), vaultId: f.id, events: [], failDirectorySync: true })
  try {
    await writeFile(join(f.dir, '.assets/proof.txt'), 'Bytes before the directory-sync crash.')
    const oid = await commit(f.dir)
    const failed = await git(['push', 'origin', 'HEAD:main'], f.dir)
    expect(failed.ok, failed.out).toBe(false)
    expect(durability.events).toEqual(['file-sync', 'rename', 'directory-sync'])
    const report = await app.inject({ method: 'GET', url: `/git/vaults/${f.id}/pushes/${oid}`, headers: { authorization: `Bearer ${f.token}` } })
    expect(report.statusCode).toBe(404)
    durability.events.length = 0
    const retry = await git(['push', 'origin', 'HEAD:main'], f.dir)
    durability.events.push('ack')
    expect(retry.ok, retry.out).toBe(true)
    expect(durability.events).toEqual(['file-sync', 'directory-sync', 'receipt', 'ack'])
  } finally { durability.enabled = false; durability.failDirectorySync = false }
}, 30_000)

it('keeps a later human attachment version when retry resumes after an already durable attachment receipt', async () => {
  const f = await pushFixture()
  await writeFile(join(f.dir, '.assets/proof.txt'), 'Agent attachment committed first.')
  await editFile(f.dir, 'docs/a.md', 'Middle line.', 'Agent middle after attachment.')
  const oid = await commit(f.dir)
  setFailpointHandler((name) => { if (name === 'edit.before-commit') throw new Error('injected failure after attachment receipt') })
  try { expect((await git(['push', 'origin', 'HEAD:main'], f.dir)).ok).toBe(false) } finally { setFailpointHandler(null) }
  const report = await app.inject({ method: 'GET', url: `/git/vaults/${f.id}/pushes/${oid}`, headers: { authorization: `Bearer ${f.token}` } })
  expect(report.statusCode, report.body).toBe(200)
  expect(report.json<{ operations: Array<{ path: string; result: { status: string } }> }>().operations).toContainEqual(expect.objectContaining({ path: '.assets/proof.txt', result: expect.objectContaining({ status: 'applied' }) }))
  await writeAsset(f.id, 'proof.txt', Buffer.from('Human version after the durable import.'))
  const retry = await git(['push', 'origin', 'HEAD:main'], f.dir)
  expect(retry.ok, retry.out).toBe(true)
  expect((await readAsset(f.id, 'proof.txt'))!.buffer.toString()).toBe('Human version after the durable import.')
}, 30_000)

async function connectionFor(id: string): Promise<string> {
  const [connection] = await db.select({ id: mcpConnections.id }).from(mcpConnections).where(eq(mcpConnections.vaultId, id)).limit(1)
  if (!connection) throw new Error('missing real fixture connection')
  return connection.id
}

async function preparedRecord(id: string, incoming: string) {
  const [row] = await db.select().from(vaultGitSnapshots)
    .where(and(eq(vaultGitSnapshots.vaultId, id), sql`${vaultGitSnapshots.manifest}->'prepared'->>'parent' = ${incoming}`)).limit(1)
  if (!row) throw new Error('missing durable canonical export journal')
  return { commitId: row.commitId, manifest: row.manifest as Manifest }
}

async function snapshotCount(id: string): Promise<number> {
  const [row] = (await db.execute(sql`SELECT count(*)::int AS n FROM vault_git_snapshots WHERE vault_id = ${id}`)) as unknown as Array<{ n: number }>
  return row!.n
}

async function mergedFixture() {
  const f = await pushFixture()
  const base = (await git(['rev-parse', 'HEAD'], f.dir)).out.trim()
  await editFile(f.dir, 'docs/a.md', 'Middle line.', 'Agent middle.')
  const incoming = await commit(f.dir)
  await updateNote(f.id, 'docs/a', { body: 'Human leading.\nFirst line.\nMiddle line.\nLast line.\n' })
  return { ...f, base, incoming }
}

describe('Git boundary regressions (#1087)', () => {
  it('never trusts an incoming fingerprint/message to bind an unserved body to a live revision', async () => {
    const f = await mergedFixture()
    const current = (await readLiveNote(f.id, 'docs/a'))!
    const expectedRev = current.row.seq + 1
    const manifest = (await loadManifest(f.id, f.base))!
    const future = Buffer.from((await readFile(join(f.dir, 'docs/a.md'), 'utf8')).replace('First line.\n', 'Human leading.\nFirst line.\n'))
    manifest.notes['docs/a.md'] = { ...manifest.notes['docs/a.md']!, rev: expectedRev, blob: assetBlobId(future) }
    const files = await Promise.all([...Object.keys(manifest.notes), ...Object.keys(manifest.assets)].sort().map(async path => ({
      path, data: path === 'docs/a.md' ? future : await readFile(join(f.dir, path)),
    })))
    const forged = createHash('sha256').update(files.map(file => `${file.path}\0${assetBlobId(file.data)}\n`).join('')).update(JSON.stringify(manifest.notes)).digest('hex')
    expect((await git(['commit', '--allow-empty', '-qm', `untrusted message\n\nelara-vault-fingerprint: ${forged}`], f.dir)).ok).toBe(true)
    const incoming = (await git(['rev-parse', 'HEAD'], f.dir)).out.trim()
    const pushed = await git(['push', 'origin', 'HEAD:main'], f.dir)
    expect(pushed.ok, pushed.out).toBe(true)
    expect((await readLiveNote(f.id, 'docs/a'))!.row.seq).toBe(expectedRev)
    expect((await git(['pull', '--ff-only', 'origin', 'main'], f.dir)).ok).toBe(true)
    const canonical = (await git(['rev-parse', 'HEAD'], f.dir)).out.trim()
    expect(canonical).not.toBe(incoming)
    expect((await git(['merge-base', '--is-ancestor', incoming, canonical], f.dir)).ok).toBe(true)
    expect(await readFile(join(f.dir, 'docs/a.md'))).toEqual(future)
    expect((await git(['show', '-s', '--format=%B', canonical], f.dir)).out).toContain(forged)
    await editFile(f.dir, 'docs/a.md', 'Agent middle.', 'Second agent middle.')
    await commit(f.dir)
    expect((await git(['push', 'origin', 'HEAD:main'], f.dir)).ok).toBe(true)
    expect((await readLiveNote(f.id, 'docs/a'))!.body).toContain('Human leading.')
  }, 30_000)

  it('rolls back an unacknowledged incoming ref and reconstructs the same canonical OID without new effects/admissions', async () => {
    const f = await mergedFixture()
    setFailpointHandler(name => {
      if (name === 'git.after-incoming-ref-before-canonical') throw new Error('injected failure between real ref publications')
    })
    try {
      const failed = await git(['push', 'origin', 'HEAD:main'], f.dir)
      expect(failed.ok, failed.out).toBe(false)
    } finally { setFailpointHandler(null) }
    expect((await git(['rev-parse', 'refs/heads/main'], vaultRemoteDir(f.id))).out.trim()).toBe(f.base)
    const prepared = await preparedRecord(f.id, f.incoming)
    const before = await snapshotCount(f.id)
    const live = (await readLiveNote(f.id, 'docs/a'))!
    const connection = await connectionFor(f.id)
    const receipts = await operationResults(f.id, connection, f.incoming)
    const limit = GIT_QUOTAS.snapshots
    GIT_QUOTAS.snapshots = before
    try {
      const retry = await git(['push', 'origin', 'HEAD:main'], f.dir)
      expect(retry.ok, retry.out).toBe(true)
    } finally { GIT_QUOTAS.snapshots = limit }
    expect((await git(['rev-parse', 'refs/heads/main'], vaultRemoteDir(f.id))).out.trim()).toBe(prepared.commitId)
    expect(await snapshotCount(f.id)).toBe(before)
    expect(await operationResults(f.id, connection, f.incoming)).toEqual(receipts)
    expect((await readLiveNote(f.id, 'docs/a'))!.row.seq).toBe(live.row.seq)
    expect((await readLiveNote(f.id, 'docs/a'))!.body).toBe(live.body)
  }, 30_000)

  it('reports failed rollback as uncertain HTTP503, retains real OIDs, and repairs the next fetch without a virtual ACK', async () => {
    const f = await mergedFixture()
    setFailpointHandler(name => {
      if (name === 'git.after-incoming-ref-before-canonical' || name === 'git.before-ref-rollback') throw new Error('injected ref/rollback failure')
    })
    try {
      const failed = await git(['push', 'origin', 'HEAD:main'], f.dir)
      expect(failed.ok, failed.out).toBe(false)
      expect(failed.out).toContain('503')
      expect(failed.out).toContain('uncertain')
    } finally { setFailpointHandler(null) }
    expect((await git(['rev-parse', 'refs/heads/main'], vaultRemoteDir(f.id))).out.trim()).toBe(f.incoming)
    expect((await git(['cat-file', '-e', f.incoming], vaultRemoteDir(f.id))).ok).toBe(true)
    const prepared = await preparedRecord(f.id, f.incoming)
    expect((await git(['pull', '--ff-only', 'origin', 'main'], f.dir)).ok).toBe(true)
    expect((await git(['rev-parse', 'HEAD'], f.dir)).out.trim()).toBe(prepared.commitId)
    expect(await readFile(join(f.dir, 'docs/a.md'), 'utf8')).toContain('Human leading.')
    await editFile(f.dir, 'docs/a.md', 'Agent middle.', 'After uncertain outcome.')
    await commit(f.dir)
    expect((await git(['push', 'origin', 'HEAD:main'], f.dir)).ok).toBe(true)
    expect((await readLiveNote(f.id, 'docs/a'))!.body).toContain('Human leading.')
  }, 30_000)

  it('rechecks live token permission and purge epoch before publishing a prepared ref', async () => {
    for (const mode of ['revoke', 'epoch'] as const) {
      const f = await mergedFixture()
      boundary.mapVault = f.id
      boundary.afterMapped = async () => {
        boundary.mapVault = ''
        if (mode === 'revoke') {
          const id = await connectionFor(f.id)
          expect((await app.inject({ method: 'POST', url: `/api/mcp-connections/${id}/revoke`, headers: { cookie } })).statusCode).toBeLessThan(300)
        } else await db.execute(sql`UPDATE notes SET purge_epoch = purge_epoch + 1 WHERE id = ${f.a.id}`)
      }
      try {
        const refused = await git(['push', 'origin', 'HEAD:main'], f.dir)
        expect(refused.ok, refused.out).toBe(false)
        expect(refused.out).toContain(mode === 'revoke' ? 'revoked' : 'purged')
      } finally { boundary.mapVault = ''; boundary.afterMapped = null }
      expect((await git(['rev-parse', 'refs/heads/main'], vaultRemoteDir(f.id))).out.trim()).toBe(f.base)
      expect((await readLiveNote(f.id, 'docs/a'))!.body).toContain('Agent middle.')
    }
  }, 30_000)

  it('reserves admission before reading bodies, bounds held requests, and releases both aborted slots', async () => {
    const token = await mint({ name: 'admission proof', scope: 'account', access: 'write', profile: 'admin' })
    for (const cycle of [0, 1]) {
      const held: ClientRequest[] = []
      const markers = [`body-${cycle}-a`, `body-${cycle}-b`]
      try {
        for (const marker of markers) {
          const req = httpRequest(`${baseUrl}/git/vaults/${vaultId}/git-receive-pack`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-git-receive-pack-request', 'content-length': '1024', 'x-git-body-proof': marker },
          })
          req.on('error', () => {})
          req.on('response', res => res.resume())
          req.setTimeout(5000, () => req.destroy())
          req.flushHeaders()
          held.push(req)
        }
        await waitFor(() => markers.every(marker => bodySeen.has(marker)))
        const full = await app.inject({
          method: 'POST', url: `/git/vaults/${vaultId}/git-receive-pack`,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'not/a-supported-parser' }, payload: 'not parsed',
        })
        expect(full.statusCode).toBe(429)
        expect(full.headers['retry-after']).toBe('1')
      } finally { held.forEach(req => req.destroy()) }
      await waitFor(() => markers.every(marker => bodyAborted.has(marker)))
    }
    const available = await app.inject({ method: 'GET', url: `/git/vaults/${vaultId}/info/refs?service=git-receive-pack`, headers: { authorization: `Bearer ${token}` } })
    expect(available.statusCode, available.body).toBe(200)
  }, 30_000)

  it('refuses noncanonical UUID aliases rather than creating a differently fenced repository', async () => {
    const token = await mint({ name: 'canonical vault proof', scope: 'account', access: 'read' })
    const alias = vaultId.toUpperCase()
    expect(alias).not.toBe(vaultId)
    const attempted = await clone(token, alias)
    expect(attempted.ok, attempted.out).toBe(false)
    expect(existsSync(vaultRemoteDir(alias))).toBe(false)
  })

  it('uses a canonical one-pass attachment codec without widening the existing store filename policy', async () => {
    const supported = ['.git', '_git', '.gitattributes', 'gitattributes', 'CON', '_CON', 'file.', 'file_', 'Case.txt', 'A'.repeat(100) + '.txt', 'b'.repeat(255)]
    const encoded = supported.map(assetGitPath)
    expect(new Set(encoded).size).toBe(supported.length)
    for (const path of encoded) expect(path.split('/').every(part => part.length <= 255)).toBe(true)
    for (const name of supported) expect(assetNameFromGitPath(assetGitPath(name))).toBe(name)
    expect(assetGitPath('%2Egit')).not.toBe(assetGitPath('.git'))
    expect(assetGitPath('%')).toBe('.assets/%25')
    expect(assetGitPath('é')).toBe('.assets/%C3%A9')
    for (const path of ['.assets/%2egit', '.assets/%2Fetc', '.assets/%5Cetc', '.assets/%2E%2E', '.assets/%GG', '.assets/%67ood.txt']) {
      expect(() => assetNameFromGitPath(path)).toThrow()
    }
    const f = await pushFixture()
    for (const name of ['%', '%2Egit', 'é']) await expect(writeAsset(f.id, name, Buffer.from('unsupported'))).rejects.toThrow()
    expect((await readAsset(f.id, 'proof.txt'))!.buffer.toString()).toBe('base asset')
  })

  it('round-trips supported hidden/nonportable attachment names byte-for-byte and serves encoded-path conflicts through the real API', async () => {
    const f = await pushFixture()
    const names = ['.git', '_git', '.gitattributes', 'gitattributes', 'CON', '_CON', 'file.', 'file_', 'Case.txt', 'A'.repeat(100) + '.txt', 'b'.repeat(255)]
    for (const name of names) await writeAsset(f.id, name, Buffer.from(`original ${name}\0`))
    expect((await git(['pull', '--ff-only', 'origin', 'main'], f.dir)).ok).toBe(true)
    for (const name of names) {
      expect(await readFile(join(f.dir, assetGitPath(name)))).toEqual(Buffer.from(`original ${name}\0`))
      await writeFile(join(f.dir, assetGitPath(name)), Buffer.from(`updated ${name}\0\xff`, 'latin1'))
    }
    await commit(f.dir)
    const pushed = await git(['push', 'origin', 'HEAD:main'], f.dir)
    expect(pushed.ok, pushed.out).toBe(true)
    for (const name of names) expect((await readAsset(f.id, name))!.buffer).toEqual(Buffer.from(`updated ${name}\0\xff`, 'latin1'))
    await writeFile(join(f.dir, assetGitPath('.git')), 'agent hidden proposal')
    const longName = 'A'.repeat(100) + '.txt'
    await writeFile(join(f.dir, assetGitPath(longName)), 'agent long-name proposal')
    const oid = await commit(f.dir)
    await writeAsset(f.id, '.git', Buffer.from('human hidden bytes'))
    await writeAsset(f.id, longName, Buffer.from('human long-name bytes'))
    expect((await git(['push', 'origin', 'HEAD:main'], f.dir)).ok).toBe(false)
    const proposal = await app.inject({ method: 'GET', url: `/git/vaults/${f.id}/pushes/${oid}/assets/.git`, headers: { authorization: `Bearer ${f.token}` } })
    expect(proposal.statusCode, proposal.body).toBe(200)
    expect(proposal.rawPayload.toString()).toBe('agent hidden proposal')
    expect((await readAsset(f.id, '.git'))!.buffer.toString()).toBe('human hidden bytes')
    const longProposal = await app.inject({ method: 'GET', url: `/git/vaults/${f.id}/pushes/${oid}/assets/${longName}`, headers: { authorization: `Bearer ${f.token}` } })
    expect(longProposal.statusCode, longProposal.body).toBe(200)
    expect(longProposal.rawPayload.toString()).toBe('agent long-name proposal')
    expect((await readAsset(f.id, longName))!.buffer.toString()).toBe('human long-name bytes')
  }, 30_000)

  it('rejects real commits containing unsupported or noncanonical attachment aliases before changing any note or existing bytes', async () => {
    const f = await pushFixture()
    const before = (await readLiveNote(f.id, 'docs/a'))!.body
    const paths = ['.assets/%25', '.assets/%C3%A9', '.assets/%2egit', '.assets/%2Fetc']
    for (const [index, path] of paths.entries()) {
      const client = index === 0 ? { dir: f.dir, ok: true, out: '' } : await clone(f.token, f.id)
      expect(client.ok, client.out).toBe(true)
      await editFile(client.dir, 'docs/a.md', 'Middle line.', 'Must not be applied.')
      expect((await git(['add', '--', 'docs/a.md'], client.dir)).ok).toBe(true)
      const blob = (await git(['rev-parse', 'HEAD:.assets/proof.txt'], client.dir)).out.trim()
      expect((await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], client.dir)).ok).toBe(true)
      expect((await git(['-c', 'user.name=Git proof', '-c', 'user.email=git-proof@localhost', 'commit', '-qm', 'invalid alias proof'], client.dir)).ok).toBe(true)
      const pushed = await git(['push', 'origin', 'HEAD:main'], client.dir)
      expect(pushed.ok, pushed.out).toBe(false)
      expect((await readLiveNote(f.id, 'docs/a'))!.body).toBe(before)
      expect((await readAsset(f.id, 'proof.txt'))!.buffer.toString()).toBe('base asset')
    }
  }, 30_000)

  it('treats a copy and then a move as explicit create/delete operations, not heuristic UUID/link reassignment', async () => {
    const f = await pushFixture()
    await writeFile(join(f.dir, 'docs/copy.md'), await readFile(join(f.dir, 'docs/a.md')))
    await commit(f.dir)
    expect((await git(['push', 'origin', 'HEAD:main'], f.dir)).ok).toBe(true)
    const copy = (await getLiveNote(f.id, 'docs/copy'))!
    expect(copy.id).not.toBe(f.a.id)
    expect((await getLiveNote(f.id, 'docs/a'))!.id).toBe(f.a.id)
    expect((await git(['pull', '--ff-only', 'origin', 'main'], f.dir)).ok).toBe(true)
    await renameFile(join(f.dir, 'docs/a.md'), join(f.dir, 'docs/moved.md'))
    await commit(f.dir)
    expect((await git(['push', 'origin', 'HEAD:main'], f.dir)).ok).toBe(true)
    expect(await getLiveNote(f.id, 'docs/a')).toBeNull()
    expect((await getLiveNote(f.id, 'docs/moved'))!.id).not.toBe(f.a.id)
    expect((await getLiveNote(f.id, 'docs/copy'))!.id).toBe(copy.id)
    const [history] = (await db.execute(sql`SELECT EXISTS (SELECT 1 FROM note_revisions WHERE note_id = ${f.a.id} AND seq = ${f.a.seq}) AS ok`)) as unknown as Array<{ ok: boolean }>
    expect(history!.ok).toBe(true)
  }, 30_000)

  it('never trashes edited/replacement source identities or duplicates a created destination when a move retries', async () => {
    for (const replace of [false, true]) {
      const f = await pushFixture()
      await renameFile(join(f.dir, 'docs/a.md'), join(f.dir, 'docs/moved.md'))
      await commit(f.dir)
      let originalPath = 'docs/a'
      if (replace) {
        await renameNote(f.id, 'docs/a', 'docs/human-renamed')
        originalPath = 'docs/human-renamed'
        await createNote(f.id, { path: 'docs/a', body: 'Replacement person text.\n' })
      }
      const tab = await human(f.id, f.a.id)
      tab.text.insert(0, 'Acknowledged human source text.\n')
      await waitFor(() => !tab.provider.hasUnsyncedChanges)
      const first = await git(['push', 'origin', 'HEAD:main'], f.dir)
      expect(first.ok, first.out).toBe(false)
      expect(first.out).toContain('non-atomic')
      const created = (await getLiveNote(f.id, 'docs/moved'))!
      expect(created.id).not.toBe(f.a.id)
      expect((await readLiveNote(f.id, originalPath))!.body).toContain('Acknowledged human source text.')
      if (replace) expect((await readLiveNote(f.id, 'docs/a'))!.body).toBe('Replacement person text.\n')
      expect((await git(['push', 'origin', 'HEAD:main'], f.dir)).ok).toBe(false)
      expect((await getLiveNote(f.id, 'docs/moved'))!.id).toBe(created.id)
      expect((await readLiveNote(f.id, originalPath))!.body).toContain('Acknowledged human source text.')
      if (replace) expect((await readLiveNote(f.id, 'docs/a'))!.body).toBe('Replacement person text.\n')
    }
  }, 30_000)

  it('refuses move/delete permission before either side, an asset change, or a proposal can mutate', async () => {
    const f = await pushFixture()
    const limited = await mint({ name: 'move without delete', scope: 'vault', vaultId: f.id, access: 'write', profile: 'admin', allowedTools: ['read_note', 'edit_note', 'create_note'] })
    const client = await clone(limited, f.id)
    expect(client.ok, client.out).toBe(true)
    await git(['config', 'user.name', 'Git proof'], client.dir)
    await git(['config', 'user.email', 'git-proof@localhost'], client.dir)
    await renameFile(join(client.dir, 'docs/a.md'), join(client.dir, 'docs/moved.md'))
    await writeFile(join(client.dir, '.assets/proof.txt'), 'must not replace asset')
    await commit(client.dir)
    const refused = await git(['push', 'origin', 'HEAD:main'], client.dir)
    expect(refused.ok, refused.out).toBe(false)
    expect(refused.out).toContain('delete_note')
    expect((await getLiveNote(f.id, 'docs/a'))!.id).toBe(f.a.id)
    expect(await getLiveNote(f.id, 'docs/moved')).toBeNull()
    expect((await readAsset(f.id, 'proof.txt'))!.buffer.toString()).toBe('base asset')
    const proposals = await db.select({ id: noteRevisions.id }).from(noteRevisions).where(and(eq(noteRevisions.noteId, f.a.id), eq(noteRevisions.action, 'proposal')))
    expect(proposals).toHaveLength(0)
  }, 30_000)

  it('preserves unrelated note/asset proposals while scoped note and revision purges redact only affected receipts', async () => {
    const f = await pushFixture()
    await editFile(f.dir, 'docs/a.md', 'First line.', 'Agent first.')
    await editFile(f.dir, 'docs/b.md', 'Another first.', 'Agent other first.')
    await writeFile(join(f.dir, '.assets/proof.txt'), 'agent binary proposal')
    const oid = await commit(f.dir)
    await updateNote(f.id, 'docs/a', { body: 'Human first.\nMiddle line.\nLast line.\n' })
    await updateNote(f.id, 'docs/b', { body: 'Human other first.\nAnother last.\n' })
    await writeAsset(f.id, 'proof.txt', Buffer.from('human binary bytes'))
    expect((await git(['push', 'origin', 'HEAD:main'], f.dir)).ok).toBe(false)
    const headers = { authorization: `Bearer ${f.token}` }
    const report = (await app.inject({ method: 'GET', url: `/git/vaults/${f.id}/pushes/${oid}`, headers })).json<{ operations: Array<{ path: string; result: { proposalId?: string; purged?: boolean } }> }>()
    const other = report.operations.find(entry => entry.path === 'docs/b.md')!.result.proposalId!
    await softDeleteNote(f.id, 'docs/a')
    expect(await purgeNote(f.id, 'docs/a')).toBe(true)
    const retained = await app.inject({ method: 'GET', url: `/git/vaults/${f.id}/pushes/${oid}`, headers })
    expect(retained.statusCode, retained.body).toBe(200)
    expect(retained.body).not.toContain('docs/a.md')
    expect(retained.json<{ operations: Array<{ result: { purged?: boolean } }> }>().operations.some(entry => entry.result.purged)).toBe(true)
    const note = await app.inject({ method: 'GET', url: `/git/vaults/${f.id}/pushes/${oid}/proposals/${other}`, headers })
    expect(note.statusCode, note.body).toBe(200)
    expect(note.body).toContain('Agent other first.')
    const binaryUrl = `/git/vaults/${f.id}/pushes/${oid}/assets/proof.txt`
    expect((await app.inject({ method: 'GET', url: binaryUrl, headers })).rawPayload.toString()).toBe('agent binary proposal')
    expect(await purgeRevision(f.id, other)).toBe(true)
    expect((await app.inject({ method: 'GET', url: binaryUrl, headers })).rawPayload.toString()).toBe('agent binary proposal')
    expect((await readAsset(f.id, 'proof.txt'))!.buffer.toString()).toBe('human binary bytes')
    expect((await readLiveNote(f.id, 'docs/b'))!.body).toContain('Human other first.')
  }, 30_000)

  it('serializes a real purge with an in-flight push without losing an independent human edit', async () => {
    const f = await pushFixture()
    const old = (await getBaseRevision(f.id, 'docs/a', f.a.seq))!
    const blob = (await git(['rev-parse', 'HEAD:docs/a.md'], f.dir)).out.trim()
    await editFile(f.dir, 'docs/a.md', 'Middle line.', 'Agent middle.')
    await commit(f.dir)
    let purge: Promise<boolean> | undefined
    let finished = false
    boundary.mapVault = f.id
    boundary.afterMapped = async () => {
      boundary.mapVault = ''
      purge = purgeRevision(f.id, old.id)
      void purge.then(() => { finished = true })
      await updateNote(f.id, 'docs/b', { body: 'Human during the prepared push.\n' })
      expect(finished).toBe(false)
    }
    try {
      const pushed = await git(['push', 'origin', 'HEAD:main'], f.dir)
      expect(pushed.ok, pushed.out).toBe(true)
      expect(purge).toBeDefined()
      expect(await purge).toBe(true)
    } finally {
      boundary.mapVault = ''; boundary.afterMapped = null
      await purge
    }
    expect(existsSync(vaultRemoteDir(f.id))).toBe(false)
    expect((await readLiveNote(f.id, 'docs/a'))!.body).toContain('Agent middle.')
    expect((await readLiveNote(f.id, 'docs/b'))!.body).toBe('Human during the prepared push.\n')
    expect((await clone(f.token, f.id)).ok).toBe(true)
    expect((await git(['cat-file', '-e', blob], vaultRemoteDir(f.id))).ok).toBe(false)
  }, 30_000)

  it('refuses exact retained-mapping/receipt limits and metadata byte admission before note/asset/proposal mutations', async () => {
    const f = await pushFixture()
    const connection = await connectionFor(f.id)
    await editFile(f.dir, 'docs/a.md', 'Middle line.', 'Must not be applied.')
    await writeFile(join(f.dir, '.assets/proof.txt'), 'must not replace asset')
    const oid = await commit(f.dir)
    const unchanged = async () => {
      expect((await readLiveNote(f.id, 'docs/a'))!.body).not.toContain('Must not be applied.')
      expect((await readAsset(f.id, 'proof.txt'))!.buffer.toString()).toBe('base asset')
      expect(await operationResults(f.id, connection, oid)).toHaveLength(0)
    }
    await db.execute(sql`INSERT INTO vault_git_push_operations (vault_id, connection_id, commit_id, path, result)
      SELECT ${f.id}, ${connection}, lpad(to_hex(i), 40, '0'), 'capacity', '{"action":"edit","status":"applied"}'::jsonb
      FROM generate_series(1, ${GIT_QUOTAS.operations}) i`)
    expect((await git(['push', 'origin', 'HEAD:main'], f.dir)).ok).toBe(false)
    await unchanged()
    await db.delete(vaultGitPushOperations).where(eq(vaultGitPushOperations.vaultId, f.id))
    await db.execute(sql`INSERT INTO vault_git_snapshots (vault_id, commit_id, manifest)
      SELECT ${f.id}, lpad(to_hex(i), 40, '0'), '{"notes":{},"assets":{}}'::jsonb
      FROM generate_series(1, ${GIT_QUOTAS.snapshots - 1}) i`)
    expect(await snapshotCount(f.id)).toBe(GIT_QUOTAS.snapshots)
    expect((await git(['push', 'origin', 'HEAD:main'], f.dir)).ok).toBe(false)
    await unchanged()
    await db.execute(sql`DELETE FROM vault_git_snapshots WHERE vault_id = ${f.id} AND commit_id LIKE '00000000000000000000%'`)
    const [usage] = (await db.execute(sql`SELECT coalesce(sum(pg_column_size(manifest)), 0)::float8 AS bytes FROM vault_git_snapshots WHERE vault_id = ${f.id}`)) as unknown as Array<{ bytes: number }>
    const limit = GIT_QUOTAS.metadataBytes
    GIT_QUOTAS.metadataBytes = usage!.bytes + GIT_QUOTAS.manifestBytes + 2 * GIT_QUOTAS.operationBytes - 1
    try {
      const refused = await git(['push', 'origin', 'HEAD:main'], f.dir)
      expect(refused.ok, refused.out).toBe(false)
      expect(refused.out).toContain('capacity')
      await unchanged()
    } finally { GIT_QUOTAS.metadataBytes = limit }
  }, 30_000)

  it('counts crash-orphaned binary evidence at the exact file/byte limits before applying anything', async () => {
    for (const mode of ['count', 'bytes'] as const) {
      const f = await pushFixture()
      const directory = join(config.dataDir, 'vaults', f.id, '.git-proposals', 'f'.repeat(40))
      await mkdir(directory, { recursive: true })
      const count = mode === 'count' ? GIT_QUOTAS.assetProposals : GIT_QUOTAS.assetProposalBytes / PACK_LIMITS.object
      for (let i = 0; i < count; i++) {
        const path = join(directory, `orphan-${i}.bin`)
        await writeFile(path, mode === 'count' ? 'x' : '')
        if (mode === 'bytes') await truncate(path, PACK_LIMITS.object)
      }
      await editFile(f.dir, 'docs/a.md', 'Middle line.', 'Must not be applied.')
      await writeFile(join(f.dir, '.assets/proof.txt'), 'must not replace asset')
      await commit(f.dir)
      const refused = await git(['push', 'origin', 'HEAD:main'], f.dir)
      expect(refused.ok, refused.out).toBe(false)
      expect(refused.out).toContain('capacity')
      expect((await readLiveNote(f.id, 'docs/a'))!.body).not.toContain('Must not be applied.')
      expect((await readAsset(f.id, 'proof.txt'))!.buffer.toString()).toBe('base asset')
      expect(await readdir(directory)).toHaveLength(count)
    }
  }, 30_000)

  it('keeps a real orphan proposal reviewable at capacity, then fences purge/retry per vault even when the old Git base OID recurs', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    try {
      const token = await mint({ name: 'purge retry scope', scope: 'account', access: 'write', profile: 'admin' })
      const first = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'purge retry first' } })).json<{ id: string }>().id
      const second = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'purge retry second' } })).json<{ id: string }>().id
      const a = await clone(token, first)
      const b = await clone(token, second)
      expect(a.ok && b.ok, a.out + b.out).toBe(true)
      const base = (await git(['rev-parse', 'HEAD'], a.dir)).out.trim()
      expect((await git(['rev-parse', 'HEAD'], b.dir)).out.trim()).toBe(base)
      await git(['config', 'user.name', 'Git proof'], a.dir)
      await git(['config', 'user.email', 'git-proof@localhost'], a.dir)
      await mkdir(join(a.dir, 'docs'))
      await writeFile(join(a.dir, 'docs/new.md'), 'Agent candidate secret.\n')
      const oid = await commit(a.dir)
      const collision = await createNote(first, { path: 'docs/new', body: 'Human collision text.\n' })
      const [connection] = await db.select({ id: mcpConnections.id }).from(mcpConnections).where(eq(mcpConnections.name, 'purge retry scope')).limit(1)
      await db.execute(sql`INSERT INTO note_revisions (note_id, frontmatter, body, actor_type, actor_id, action, actor_detail)
        SELECT ${collision.id}, '{}'::jsonb, 'retained capacity evidence', 'mcp', ${connection!.id}, 'proposal',
          ${JSON.stringify({ kind: 'git_push', commit: 'f'.repeat(40) })}::jsonb
        FROM generate_series(1, ${GIT_QUOTAS.noteProposals - 1})`)
      boundary.failReceipt = `${first}:docs/new.md`
      const interrupted = await git(['push', 'origin', 'HEAD:main'], a.dir)
      expect(interrupted.ok, interrupted.out).toBe(false)
      const [count] = (await db.execute(sql`SELECT count(*)::int AS n FROM note_revisions WHERE note_id = ${collision.id} AND action = 'proposal'`)) as unknown as Array<{ n: number }>
      expect(count!.n).toBe(GIT_QUOTAS.noteProposals)
      const history = await app.inject({ method: 'GET', url: `/api/vaults/${first}/history/docs/new`, headers: { cookie } })
      expect(history.statusCode, history.body).toBe(200)
      expect(history.body).toContain('proposal')
      const [orphan] = (await db.execute(sql`SELECT id FROM note_revisions WHERE note_id = ${collision.id}
        AND actor_detail->>'commit' = ${oid} ORDER BY ord DESC LIMIT 1`)) as unknown as Array<{ id: string }>
      expect(orphan).toBeDefined()
      const preview = await app.inject({ method: 'GET', url: `/api/vaults/${first}/revisions/${orphan!.id}`, headers: { cookie } })
      expect(preview.statusCode, preview.body).toBe(200)
      expect(preview.body).toContain('Agent candidate secret.')
      const full = await git(['push', 'origin', 'HEAD:main'], a.dir)
      expect(full.ok, full.out).toBe(false)
      expect(full.out).toContain('capacity')
      expect((await readLiveNote(first, 'docs/new'))!.body).toBe('Human collision text.\n')
      await softDeleteNote(first, 'docs/new')
      expect(await purgeNote(first, 'docs/new')).toBe(true)
      const clean = await clone(token, first)
      expect(clean.ok, clean.out).toBe(true)
      expect((await git(['rev-parse', 'HEAD'], clean.dir)).out.trim()).toBe(base)
      const retry = await git(['push', 'origin', 'HEAD:main'], a.dir)
      expect(retry.ok, retry.out).toBe(false)
      expect(retry.out).toContain('purged')
      expect(await getLiveNote(first, 'docs/new')).toBeNull()
      const receipts = await operationResults(first, connection!.id, oid)
      expect(receipts.some(entry => entry.result.purged)).toBe(true)
      expect(JSON.stringify(receipts)).not.toContain('docs/new')
      expect(JSON.stringify(receipts)).not.toContain('Agent candidate secret')
      const otherUrl = baseUrl.replace('http://', `http://elara:${token}@`) + `/git/vaults/${second}`
      expect((await git(['remote', 'add', 'other', otherUrl], a.dir)).ok).toBe(true)
      const other = await git(['push', 'other', 'HEAD:main'], a.dir)
      expect(other.ok, other.out).toBe(true)
      expect((await readLiveNote(second, 'docs/new'))!.body).toBe('Agent candidate secret.\n')
    } finally { clock.mockRestore(); boundary.failReceipt = '' }
  }, 30_000)

  it('preflights export source count and bytes in SQL before rendering or allocating file buffers', async () => {
    const f = await pushFixture()
    for (const mode of ['count', 'bytes'] as const) {
      const objects = PACK_LIMITS.objects
      const expanded = PACK_LIMITS.expanded
      if (mode === 'count') PACK_LIMITS.objects = 1
      else PACK_LIMITS.expanded = 1
      boundary.countRenders = true
      boundary.renders = 0
      try {
        const refused = await clone(f.token, f.id)
        expect(refused.ok, refused.out).toBe(false)
        expect(boundary.renders).toBe(0)
      } finally {
        boundary.countRenders = false
        PACK_LIMITS.objects = objects
        PACK_LIMITS.expanded = expanded
      }
      expect((await readAsset(f.id, 'proof.txt'))!.buffer.toString()).toBe('base asset')
    }
  }, 30_000)

  it('refuses the exact 256 MiB retained note-proposal byte boundary before changing notes or assets', async () => {
    const f = await pushFixture()
    const connection = await connectionFor(f.id)
    const tag = JSON.stringify({ kind: 'git_push', commit: 'e'.repeat(40), quotaFixture: 'note-bytes' })
    try {
      await db.execute(sql`INSERT INTO note_revisions (note_id, frontmatter, body, actor_type, actor_id, action, actor_detail)
        SELECT ${f.a.id}, '{}'::jsonb, repeat('q', ${GIT_QUOTAS.noteProposalBytes / 256 - 2}), 'mcp', ${connection}, 'proposal', ${tag}::jsonb
        FROM generate_series(1, 256)`)
      const [usage] = (await db.execute(sql`SELECT sum(octet_length(body) + octet_length(frontmatter::text))::float8 AS bytes
        FROM note_revisions WHERE note_id = ${f.a.id} AND action = 'proposal'`)) as unknown as Array<{ bytes: number }>
      expect(usage!.bytes).toBe(GIT_QUOTAS.noteProposalBytes)
      await editFile(f.dir, 'docs/a.md', 'Middle line.', 'Must not be applied.')
      await writeFile(join(f.dir, '.assets/proof.txt'), 'must not replace asset')
      await commit(f.dir)
      const refused = await git(['push', 'origin', 'HEAD:main'], f.dir)
      expect(refused.ok, refused.out).toBe(false)
      expect(refused.out).toContain('capacity')
      expect((await readLiveNote(f.id, 'docs/a'))!.body).not.toContain('Must not be applied.')
      expect((await readAsset(f.id, 'proof.txt'))!.buffer.toString()).toBe('base asset')
    } finally {
      await db.execute(sql`DELETE FROM note_revisions WHERE note_id = ${f.a.id} AND actor_detail->>'quotaFixture' = 'note-bytes'`)
    }
  }, 30_000)

  it('restarts after a real SIGKILL after durable quarantine mapping, rebuilds the same canonical OID, and does not duplicate effects or admissions', async () => {
    const id = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'real Git crash' } })).json<{ id: string }>().id
    const note = await createNote(id, { path: 'docs/crash', body: 'First.\nMiddle.\nLast.\n' })
    const token = await mint({ name: 'real crash writer', scope: 'vault', vaultId: id, access: 'write', profile: 'admin' })
    const root = await mkdtemp(join(tmpdir(), 'git-crash-data-'))
    dirs.push(root)
    let run: GitChildRun | undefined
    try {
      run = await startGitChild(root, 'git.after-mapping-before-publication')
      const directory = await mkdtemp(join(tmpdir(), 'git-crash-clone-'))
      dirs.push(directory)
      const url = (base: string) => base.replace('http://', `http://elara:${token}@`) + `/git/vaults/${id}`
      expect((await git(['clone', '--quiet', url(run.url), directory])).ok).toBe(true)
      await git(['config', 'user.name', 'Git proof'], directory)
      await git(['config', 'user.email', 'git-proof@localhost'], directory)
      await editFile(directory, 'docs/crash.md', 'Middle.', 'Agent middle.')
      const incoming = await commit(directory)
      await updateNote(id, 'docs/crash', { body: 'Human leading.\nFirst.\nMiddle.\nLast.\n' })
      const failed = await git(['push', 'origin', 'HEAD:main'], directory)
      expect(failed.ok, failed.out).toBe(false)
      expect((await run.exited).signal).toBe('SIGKILL')
      expect(run.output()).toContain('git.after-mapping-before-publication: SIGKILL')
      const prepared = await preparedRecord(id, incoming)
      const count = await snapshotCount(id)
      const afterCrash = (await readLiveNote(id, 'docs/crash'))!
      expect(afterCrash.body).toBe('Human leading.\nFirst.\nAgent middle.\nLast.\n')
      const connection = await connectionFor(id)
      const receipts = await operationResults(id, connection, incoming)
      expect(receipts).toHaveLength(1)
      expect((await readdir(join(root, 'git-remotes'))).some(name => name.startsWith('.push-'))).toBe(true)
      run = await startGitChild(root, '')
      expect((await readdir(join(root, 'git-remotes'))).some(name => name.startsWith('.push-'))).toBe(false)
      run.child.send({ type: 'quota', snapshots: count })
      await gitChildMessage(run.child, 'quota-set')
      expect((await git(['remote', 'set-url', 'origin', url(run.url)], directory)).ok).toBe(true)
      const retry = await git(['push', 'origin', 'HEAD:main'], directory)
      expect(retry.ok, retry.out).toBe(true)
      expect((await git(['pull', '--ff-only', 'origin', 'main'], directory)).ok).toBe(true)
      expect((await git(['rev-parse', 'HEAD'], directory)).out.trim()).toBe(prepared.commitId)
      expect((await git(['merge-base', '--is-ancestor', incoming, 'HEAD'], directory)).ok).toBe(true)
      expect((await git(['status', '--porcelain'], directory)).out.trim()).toBe('')
      expect(await snapshotCount(id)).toBe(count)
      expect(await operationResults(id, connection, incoming)).toEqual(receipts)
      const afterRetry = (await readLiveNote(id, 'docs/crash'))!
      expect(afterRetry.row.id).toBe(note.id)
      expect(afterRetry.row.seq).toBe(afterCrash.row.seq)
      expect(afterRetry.body).toBe(afterCrash.body)
    } finally { if (run) await stopGitChild(run) }
  }, 60_000)

  it('bounds the request and kills an actual Git subprocess group, including its live child', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'git-budget-'))
    dirs.push(directory)
    const readyFile = join(directory, 'ready')
    await boundedGit(['init', '--bare', '--quiet', '--object-format=sha1', directory], directory)
    const budget = PACK_LIMITS.workMilliseconds
    PACK_LIMITS.workMilliseconds = 0
    try { await expect(withGitBudget(() => boundedGit(['--version'], directory))).rejects.toThrow('work limit') }
    finally { PACK_LIMITS.workMilliseconds = budget }
    // Control the parent's deadline, not the real external child's clock.
    // The child signals readiness; no guessed sleep stands in for its exit.
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const script = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(readyFile + '.tmp')},String(process.pid));fs.renameSync(${JSON.stringify(readyFile + '.tmp')},${JSON.stringify(readyFile)});setInterval(()=>{},1000)`
    const commandLimit = PACK_LIMITS.milliseconds
    PACK_LIMITS.milliseconds = 500
    let notifyReady!: (pid: number) => void
    let failReady!: (err: unknown) => void
    const ready = new Promise<number>((resolve, reject) => { notifyReady = resolve; failReady = reject })
    const watcher = watch(directory, (_event, name) => {
      if (name === 'ready') void readFile(readyFile, 'utf8').then(value => notifyReady(Number(value)), failReady)
    })
    // A real setup guard is needed for external-process failure, not a guessed wait.
    const realClearTimeout = globalThis.clearTimeout
    const guard = setTimeout(() => failReady(new Error('Git child did not signal readiness')), 5000)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = boundedGit(['-c', `alias.elara-budget=!exec ${quote(process.execPath)} -e ${quote(script)}`, 'elara-budget'], directory)
      .then(() => null, (err: unknown) => err)
    let pid = 0
    let gone = false
    try {
      pid = await ready
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
      vi.advanceTimersByTime(500)
      vi.useRealTimers()
      await waitFor(() => {
        try { process.kill(pid, 0); return false }
        catch (err) { return (err as NodeJS.ErrnoException).code === 'ESRCH' }
      })
      gone = true
    } finally {
      watcher.close()
      realClearTimeout(guard)
      if (vi.isFakeTimers()) vi.runOnlyPendingTimers()
      vi.useRealTimers()
      PACK_LIMITS.milliseconds = commandLimit
      if (pid > 0 && !gone) {
        try { process.kill(pid, 'SIGKILL') } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err }
      }
      const failure = await pending
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('time limit')
    }
  }, 30_000)
})

interface GitChildRun {
  child: ChildProcess
  url: string
  output: () => string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}
const gitChildren: GitChildRun[] = []

/** Real subprocess IPC needs a platform-clock guard; it is not a delay or a readiness guess. */
async function gitChildMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const guard = setTimeout(() => controller.abort(), 20_000)
  try {
    for (;;) {
      const [message] = await once(child, 'message', { signal: controller.signal })
      if (message && typeof message === 'object' && 'type' in message && message.type === type) return message as Record<string, unknown>
    }
  } finally { clearTimeout(guard) }
}

async function startGitChild(root: string, failpoints: string): Promise<GitChildRun> {
  const temporary = join(root, 'tmp')
  await mkdir(temporary, { recursive: true })
  const child = fork(fileURLToPath(new URL('./fixtures/vault-git-child.ts', import.meta.url)), [], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env, ELARA_DATA_DIR: root, CHAPTERS_DATA_DIR: root, DATA_DIR: root,
      ELARA_LOCAL_REPOS_ROOT: join(root, 'local-repos'), ELARA_FAILPOINTS: failpoints, TMPDIR: temporary,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(-64 * 1024) })
  child.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(-64 * 1024) })
  const exited = once(child, 'close').then(([code, signal]) => ({ code: code as number | null, signal: signal as NodeJS.Signals | null }))
  const run: GitChildRun = { child, url: '', output: () => output, exited }
  gitChildren.push(run)
  try {
    const ready = await gitChildMessage(child, 'ready')
    if (typeof ready.port !== 'number') throw new Error('private Git child did not provide a port')
    run.url = `http://127.0.0.1:${ready.port}`
    return run
  } catch (err) {
    await stopGitChild(run)
    throw err
  }
}

async function stopGitChild(run: GitChildRun): Promise<void> {
  if (run.child.exitCode !== null || run.child.signalCode !== null) { await run.exited; return }
  if (run.child.connected) run.child.send({ type: 'stop' })
  else run.child.kill('SIGTERM')
  const guard = setTimeout(() => run.child.kill('SIGKILL'), 10_000)
  try { await run.exited } finally { clearTimeout(guard) }
}

afterAll(async () => { for (const run of gitChildren) await stopGitChild(run) })

it('Git boundary: concurrent attachment staging is never listed, cloned or treated as a user filename', async () => {
  const f = await pushFixture()
  let entered!: () => void
  let release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  boundary.renameTarget = assetFile(f.id, 'proof.txt')
  boundary.beforeAssetRename = async () => { entered(); await gate }
  const upload = writeAsset(f.id, 'proof.txt', Buffer.from('future published bytes'))
  try {
    await Promise.race([ready, upload.then(() => { throw new Error('real asset rename boundary was not observed') })])
    const listing = await app.inject({ method: 'GET', url: `/api/vaults/${f.id}/assets`, headers: { cookie } })
    expect(listing.statusCode, listing.body).toBe(200)
    expect(listing.body).not.toContain('.atomic..')
    const c = await clone(f.token, f.id)
    expect(c.ok, c.out).toBe(true)
    expect((await git(['ls-files'], c.dir)).out).not.toContain('.atomic')
    expect(await readFile(join(c.dir, '.assets/proof.txt'), 'utf8')).toBe('base asset')
  } finally {
    boundary.renameTarget = ''; boundary.beforeAssetRename = null
    release()
    await upload
  }
  expect((await readAsset(f.id, 'proof.txt'))!.buffer.toString()).toBe('future published bytes')
}, 30_000)
