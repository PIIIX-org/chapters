// #677/#1087: real Git smart-HTTP clone/edit/push, live collaborative edits, bounded failures and explicit purge.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { setTimeout as sleep } from 'node:timers/promises'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { db } from '../src/db/client.js'
import { vaults } from '../src/db/schema.js'
import { sweepVaultRemotes, vaultRemoteDir } from '../src/git-remote/vault-remote.js'
import { createNote, getBaseRevision, getLiveNote, purgeNote, purgeRevision, readAsset, readLiveNote, renameNote, softDeleteNote, updateNote, writeAsset } from '../src/notes/store.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { setFailpointHandler } from '../src/failpoints.js'
import { purgeVaultRecord } from '../src/vaults/routes.js'

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
  providers.forEach((provider) => provider.destroy())
  await collab.destroy()
  await app.close()
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
    await writeFile(join(f.dir, 'assets/proof.txt'), 'replacement asset')
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
    await rm(join(f.dir, 'assets/proof.txt'))
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
    await writeFile(join(f.dir, 'assets/proof.txt'), 'agent asset version')
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
