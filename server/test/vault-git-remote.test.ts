// #677 (read-only slice): a vault is a git remote an agent clones to grep its notes locally. Smart HTTP, upload-pack
// only: `GET /git/vaults/:id/info/refs?service=git-upload-pack` and `POST /git/vaults/:id/git-upload-pack`, authenticated
// with an MCP token (Basic password or Bearer), checked live on every request against the vault. The content is the
// vault's notes as `<path>.md` files (the projector's file form), one commit per change of content; nothing can be pushed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { db } from '../src/db/client.js'
import { vaults } from '../src/db/schema.js'
import { sweepVaultRemotes, vaultRemoteDir } from '../src/git-remote/vault-remote.js'
import { createNote, softDeleteNote, updateNote } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

const sh = promisify(execFile)
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir() }

let app: FastifyInstance
let baseUrl: string
let cookie: string
let vaultId: string
let otherVaultId: string
const dirs: string[] = []

async function mint(body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body })
  expect(res.statusCode, res.body).toBe(200)
  return res.json<{ token: string }>().token
}

async function git(args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await sh('git', ['-c', 'credential.helper=', ...args], { cwd, env: GIT_ENV })
    return { ok: true, out: r.stdout + r.stderr }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, out: (e.stdout ?? '') + (e.stderr ?? '') }
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
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'git remote vault' } })).json<{ id: string }>().id
  otherVaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'other vault' } })).json<{ id: string }>().id
  await createNote(vaultId, { path: 'docs/alpha', frontmatter: { title: 'Alpha' }, body: 'The alpha note mentions pelicans.\n' })
  await createNote(vaultId, { path: 'beta', body: 'Beta is about herons.\n' })
  await createNote(otherVaultId, { path: 'secret', body: 'The other vault holds albatross plans.\n' })
}, 60_000)

afterAll(async () => {
  await app.close()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

describe('a vault is a read-only git remote (#677)', () => {
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

  it('cannot push: receive-pack is refused, and a push from a clone changes nothing', async () => {
    const token = await mint({ name: 'git-write', scope: 'account', access: 'write' })
    const refused = await app.inject({ method: 'GET', url: `/git/vaults/${vaultId}/info/refs?service=git-receive-pack`, headers: { authorization: `Bearer ${token}` } })
    expect(refused.statusCode).toBe(403)
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

  it('a changed note is in the next fetch (a pull moves on), a deleted one is gone, and equal content is the same commit', async () => {
    const token = await mint({ name: 'git-fetch', scope: 'account', access: 'read' })
    const c = await clone(token)
    expect(c.ok, c.out).toBe(true)
    const head = (await git(['rev-parse', 'HEAD'], c.dir)).out.trim()
    expect((await clone(token)).ok).toBe(true)
    expect((await git(['pull', '--quiet'], c.dir)).out).not.toMatch(/fatal|error/)
    expect((await git(['rev-parse', 'HEAD'], c.dir)).out.trim()).toBe(head)

    await updateNote(vaultId, 'beta', { body: 'Beta is about storks now.\n' })
    const pull = await git(['pull', '--quiet'], c.dir)
    expect(pull.ok, pull.out).toBe(true)
    expect(await readFile(join(c.dir, 'beta.md'), 'utf8')).toContain('storks')
    expect((await git(['rev-parse', 'HEAD'], c.dir)).out.trim()).not.toBe(head)
  })

  it('a deleted note is gone from the next fetch, and the repository of a deleted vault is swept', async () => {
    const token = await mint({ name: 'git-delete', scope: 'account', access: 'read' })
    const id = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'short-lived' } })).json<{ id: string }>().id
    await createNote(id, { path: 'keep', body: 'kept\n' })
    await createNote(id, { path: 'drop', body: 'dropped\n' })
    const c = await clone(token, id)
    expect(c.ok, c.out).toBe(true)
    await softDeleteNote(id, 'drop')
    expect((await git(['pull', '--quiet'], c.dir)).ok).toBe(true)
    expect((await git(['ls-files'], c.dir)).out.trim()).toBe('keep.md')

    expect(existsSync(vaultRemoteDir(id))).toBe(true)
    await db.delete(vaults).where(eq(vaults.id, id))
    expect(await sweepVaultRemotes()).toBeGreaterThanOrEqual(1)
    expect(existsSync(vaultRemoteDir(id))).toBe(false)
  })
})
