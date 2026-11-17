import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { logSecurityEvent } from '../auth/security-events.js'
import { atLeast, resolveAccess, UUID_REGEX } from '../vaults/permissions.js'
import { resolveMcpToken, type McpAuth } from '../vaults/mcp-connection-routes.js'
import { checkRateLimit } from '../mcp/rate-limit.js'
import { ACCESS_RANK, PROFILE_RANK } from '../mcp/server.js'
import { ensureVaultRemote } from './vault-remote.js'
import { operationResults } from './metadata.js'
import { assetProposalFile } from './apply.js'
import { getRevision, isSafeAssetName } from '../notes/store.js'
import { withVaultGit } from './lifecycle.js'
import { advertisement, boundedGit, GitPushError, PACK_LIMITS, withGitBudget } from './pack.js'
import { receiveHead, receivePush } from './receive.js'
import { assetGitPath } from './tree.js'

const MAX_UPLOAD_REQUEST = 1024 * 1024
let admitted = 0
const requests = new WeakMap<FastifyRequest, { started: boolean; aborted: boolean; timer: NodeJS.Timeout }>()

function release(req: FastifyRequest): void {
  const state = requests.get(req)
  if (!state) return
  clearTimeout(state.timer)
  requests.delete(req)
  admitted--
}

/** Reserve before body parsing, then keep the slot while waiting for this vault or sending its response. */
async function gitRequest<T>(req: FastifyRequest<{ Params: { vaultId: string } }>, work: () => Promise<T>): Promise<T> {
  const state = requests.get(req)
  if (!state) throw new GitPushError('Git request was not admitted')
  state.started = true
  clearTimeout(state.timer)
  try {
    return await withGitBudget(() => withVaultGit(req.params.vaultId, async () => {
      if (state.aborted) throw new GitPushError('Git request was aborted')
      return work()
    }))
  } finally { release(req) }
}

async function refuse(reply: FastifyReply | undefined, statusCode: number, error: string): Promise<null> {
  if (!reply) throw new GitPushError(error)
  if (statusCode === 401) reply.header('www-authenticate', 'Basic realm="Elara vault"')
  await reply.code(statusCode).send({ error })
  return null
}

/** Live token/scope/pin/allow-list checks; no distinction between an unreachable and a nonexistent vault. */
async function authorise(req: FastifyRequest<{ Params: { vaultId: string } }>, reply: FastifyReply | undefined, write = false, countRate = false): Promise<{ vaultId: string; auth: McpAuth } | null> {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7)
    : header?.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':') : null
  if (!token) return refuse(reply, 401, 'a token is required')
  const auth = await resolveMcpToken(token)
  if (!auth) {
    await logSecurityEvent({ type: 'mcp_auth_failed', ip: req.ip })
    return refuse(reply, 401, 'invalid, revoked or expired token')
  }
  if (countRate) {
    const limit = checkRateLimit(auth.connection.id)
    if (!limit.ok) {
      reply?.header('retry-after', String(Math.ceil(limit.retryAfterMs / 1000)))
      return refuse(reply, 429, 'rate limited')
    }
  }
  const { vaultId } = req.params
  const { connection } = auth
  const access = UUID_REGEX.test(vaultId) && vaultId === vaultId.toLowerCase() ? await resolveAccess(auth.user.id, vaultId) : null
  const reachable = access !== null &&
    (connection.scope === 'account' || (connection.scope === 'vault' && connection.vaultId === vaultId)) &&
    (!connection.allowedTools || connection.allowedTools.includes('read_note'))
  if (!reachable) return refuse(reply, 404, 'not found')
  if (write && (ACCESS_RANK[connection.access] < ACCESS_RANK.write || PROFILE_RANK[connection.profile] < PROFILE_RANK.writer || !atLeast(access, 'edit'))) {
    return refuse(reply, 403, 'a writer-profile write token and vault edit permission are required')
  }
  return { vaultId, auth }
}

function requestBody(req: FastifyRequest, cap: number): Buffer {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  const encoding = req.headers['content-encoding']
  if (encoding && encoding !== 'identity' && encoding !== 'gzip') throw new GitPushError('unsupported content encoding')
  if (encoding !== 'gzip') return raw
  try { return gunzipSync(raw, { maxOutputLength: cap }) } catch {
    throw Object.assign(new GitPushError('request too large or not gzip'), { statusCode: 413 })
  }
}

/** Smart HTTP plus a reachable, permission-checked proposal/import report API. */
export function vaultGitRoutes(app: FastifyInstance) {
  app.register(async (instance) => {
    instance.addHook('onRequest', async (req, reply) => {
      if (admitted >= 2) return reply.code(429).header('retry-after', '1').send({ error: 'Git capacity is busy' })
      admitted++
      const state = {
        started: false, aborted: false,
        timer: setTimeout(() => {
          state.aborted = true
          req.raw.destroy(new Error('Git body/authentication time limit exceeded'))
          if (!state.started) release(req)
        }, PACK_LIMITS.milliseconds),
      }
      requests.set(req, state)
      const service = req.query && typeof req.query === 'object' && 'service' in req.query ? req.query.service : undefined
      const write = req.routeOptions.url?.includes('/pushes/') || req.routeOptions.url?.endsWith('/git-receive-pack') ||
        service === 'git-receive-pack'
      await authorise(req as FastifyRequest<{ Params: { vaultId: string } }>, reply, Boolean(write), true)
    })
    instance.addHook('onResponse', async req => { release(req) })
    instance.addHook('onRequestAbort', async req => {
      const state = requests.get(req)
      if (!state) return
      state.aborted = true
      if (!state.started) release(req)
    })
    for (const service of ['upload', 'receive']) {
      instance.addContentTypeParser(`application/x-git-${service}-pack-request`, { parseAs: 'buffer' }, (_req, body: Buffer, done) => done(null, body))
    }
    instance.get<{ Params: { vaultId: string }; Querystring: { service?: string } }>('/git/vaults/:vaultId/info/refs', async (req, reply) =>
      gitRequest(req, async () => {
        const write = req.query.service === 'git-receive-pack'
        const allowed = await authorise(req, reply, write)
        if (!allowed) return reply
        if (!['git-upload-pack', 'git-receive-pack'].includes(req.query.service ?? '')) return reply.code(400).send({ error: 'unsupported Git service' })
        if (write) return reply.header('content-type', 'application/x-git-receive-pack-advertisement').header('cache-control', 'no-cache').send(advertisement(await receiveHead(allowed.vaultId)))
        const { dir } = await ensureVaultRemote(allowed.vaultId)
        const body = await boundedGit(['upload-pack', '--stateless-rpc', '--advertise-refs', dir], dir, Buffer.alloc(0))
        const banner = '# service=git-upload-pack\n'
        const prefix = `${(banner.length + 4).toString(16).padStart(4, '0')}${banner}0000`
        return reply.header('content-type', 'application/x-git-upload-pack-advertisement').header('cache-control', 'no-cache').send(Buffer.concat([Buffer.from(prefix), body]))
      }))

    instance.post<{ Params: { vaultId: string } }>('/git/vaults/:vaultId/git-upload-pack', { bodyLimit: MAX_UPLOAD_REQUEST }, async (req, reply) =>
      gitRequest(req, async () => {
        const allowed = await authorise(req, reply)
        if (!allowed) return reply
        const request = requestBody(req, MAX_UPLOAD_REQUEST)
        const { dir } = await ensureVaultRemote(allowed.vaultId)
        const result = await boundedGit(['upload-pack', '--stateless-rpc', dir], dir, request, PACK_LIMITS.expanded * 2).catch(() => null)
        if (!result) return reply.code(400).send({ error: 'invalid or over-limit Git upload request' })
        return reply.header('content-type', 'application/x-git-upload-pack-result').header('cache-control', 'no-cache').send(result)
      }))

    instance.post<{ Params: { vaultId: string } }>('/git/vaults/:vaultId/git-receive-pack', { bodyLimit: PACK_LIMITS.request }, async (req, reply) =>
      gitRequest(req, async () => {
        const allowed = await authorise(req, reply, true)
        if (!allowed) return reply
        const checkWrite = async (): Promise<McpAuth> => {
          const latest = await authorise(req, undefined, true)
          if (!latest) throw new GitPushError('write authorisation changed')
          return latest.auth
        }
        const body = await receivePush(allowed.vaultId, requestBody(req, PACK_LIMITS.request), checkWrite)
        return reply.header('content-type', 'application/x-git-receive-pack-result').header('cache-control', 'no-cache').send(body)
      }))

    instance.get<{ Params: { vaultId: string; commitId: string } }>('/git/vaults/:vaultId/pushes/:commitId', async (req, reply) =>
      gitRequest(req, async () => {
        const allowed = await authorise(req, reply, true)
        if (!allowed) return reply
        if (!/^[0-9a-f]{40}$/.test(req.params.commitId)) return reply.code(404).send({ error: 'not found' })
        const operations = await operationResults(allowed.vaultId, allowed.auth.connection.id, req.params.commitId)
        if (!operations.length) return reply.code(404).send({ error: 'not found' })
        return reply.send({ commit: req.params.commitId, atomic: false, operations })
      }))

    instance.get<{ Params: { vaultId: string; commitId: string; revisionId: string } }>('/git/vaults/:vaultId/pushes/:commitId/proposals/:revisionId', async (req, reply) =>
      gitRequest(req, async () => {
        const allowed = await authorise(req, reply, true)
        if (!allowed) return reply
        if (!/^[0-9a-f]{40}$/.test(req.params.commitId) || !UUID_REGEX.test(req.params.revisionId)) return reply.code(404).send({ error: 'not found' })
        const operations = await operationResults(allowed.vaultId, allowed.auth.connection.id, req.params.commitId)
        if (!operations.some((entry) => entry.result.proposalId === req.params.revisionId)) return reply.code(404).send({ error: 'not found' })
        const revision = await getRevision(allowed.vaultId, req.params.revisionId)
        if (!revision) return reply.code(404).send({ error: 'not found' })
        // Await response completion under the purge barrier; do not release it with unsent plaintext.
        return reply.header('cache-control', 'no-store').send(revision)
      }))

    instance.get<{ Params: { vaultId: string; commitId: string; '*': string } }>('/git/vaults/:vaultId/pushes/:commitId/assets/*', async (req, reply) =>
      gitRequest(req, async () => {
        const allowed = await authorise(req, reply, true)
        if (!allowed) return reply
        const { commitId } = req.params
        const name = req.params['*']
        if (!/^[0-9a-f]{40}$/.test(commitId) || !isSafeAssetName(name)) return reply.code(404).send({ error: 'not found' })
        const operations = await operationResults(allowed.vaultId, allowed.auth.connection.id, commitId)
        if (!operations.some((entry) => entry.path === assetGitPath(name) && entry.result.status === 'conflicted')) return reply.code(404).send({ error: 'not found' })
        const handle = await open(assetProposalFile(allowed.vaultId, commitId, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT' || err.code === 'ELOOP' || err.code === 'ENOTDIR') return null
          throw err
        })
        if (!handle) return reply.code(404).send({ error: 'not found' })
        let data: Buffer
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.size > PACK_LIMITS.object) return reply.code(404).send({ error: 'not found' })
          data = await handle.readFile()
        } finally { await handle.close() }
        if (data.length > PACK_LIMITS.object) return reply.code(404).send({ error: 'not found' })
        return reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'no-store').send(data)
      }))
  })
}
