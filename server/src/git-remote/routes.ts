import { spawn } from 'node:child_process'
import { gunzipSync } from 'node:zlib'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { logSecurityEvent } from '../auth/security-events.js'
import { resolveAccess, UUID_REGEX } from '../vaults/permissions.js'
import { resolveMcpToken } from '../vaults/mcp-connection-routes.js'
import { checkRateLimit } from '../mcp/rate-limit.js'
import { ensureVaultRemote } from './vault-remote.js'

/** An upload-pack request names refs and wants: a few KiB. The cap holds for the body and for what it inflates to. */
const MAX_REQUEST_BYTES = 1024 * 1024

/**
 * A vault as a read-only git remote (#677; vault-remote.ts): smart HTTP, upload-pack only, so `git clone`, `fetch` and
 * `pull` work and `git push` is refused. A request is authenticated with an MCP token, as the password of HTTP Basic
 * (any user name; what git sends) or as a Bearer token, resolved live (revoked, expired, inactive owners never
 * resolve), and authorised against the vault on EVERY request, `info/refs` and each pack: a connection pinned to another
 * vault or to a repository, one whose tool allow-list lacks `read_note`, and an account without read access to the vault
 * all get the 404 a missing vault gets. A refusal never says which.
 */
export function vaultGitRoutes(app: FastifyInstance) {
  app.register(async (instance) => {
    // Git posts its negotiation as `application/x-git-upload-pack-request`, gzip-encoded once it is large.
    instance.addContentTypeParser('application/x-git-upload-pack-request', { parseAs: 'buffer' }, (_req, body: Buffer, done) => done(null, body))

    /** The vault the request may read, or null after a refusal has been sent. */
    const authorise = async (req: FastifyRequest<{ Params: { vaultId: string } }>, reply: FastifyReply): Promise<string | null> => {
      const header = req.headers.authorization
      const token = header?.startsWith('Bearer ')
        ? header.slice(7)
        : header?.startsWith('Basic ')
          ? Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':')
          : null
      if (!token) {
        await reply.code(401).header('www-authenticate', 'Basic realm="Elara vault"').send({ error: 'a token is required' })
        return null
      }
      const auth = await resolveMcpToken(token)
      if (!auth) {
        await logSecurityEvent({ type: 'mcp_auth_failed', ip: req.ip })
        await reply.code(401).header('www-authenticate', 'Basic realm="Elara vault"').send({ error: 'invalid, revoked or expired token' })
        return null
      }
      const limit = checkRateLimit(auth.connection.id)
      if (!limit.ok) {
        await reply.code(429).header('retry-after', String(Math.ceil(limit.retryAfterMs / 1000))).send({ error: 'rate limited' })
        return null
      }
      const { vaultId } = req.params
      const { connection } = auth
      const reachable =
        UUID_REGEX.test(vaultId) &&
        (connection.scope === 'account' || (connection.scope === 'vault' && connection.vaultId === vaultId)) &&
        (!connection.allowedTools || connection.allowedTools.includes('read_note')) &&
        (await resolveAccess(auth.user.id, vaultId)) !== null
      if (!reachable) {
        await reply.code(404).send({ error: 'not found' })
        return null
      }
      return vaultId
    }

    const advertise = async (req: FastifyRequest<{ Params: { vaultId: string }; Querystring: { service?: string } }>, reply: FastifyReply) => {
      if (req.query.service === 'git-receive-pack') {
        // Read-only: say so after the token is known to be valid, but never for a vault the caller cannot reach.
        const vaultId = await authorise(req, reply)
        if (vaultId === null) return reply
        return reply.code(403).send({ error: 'this remote is read-only' })
      }
      if (req.query.service !== 'git-upload-pack') return reply.code(400).send({ error: 'service must be git-upload-pack' })
      const vaultId = await authorise(req, reply)
      if (vaultId === null) return reply
      const dir = await ensureVaultRemote(vaultId)
      const body = await upload(dir, ['--advertise-refs'], Buffer.alloc(0))
      const banner = '# service=git-upload-pack\n'
      const head = `${(banner.length + 4).toString(16).padStart(4, '0')}${banner}0000`
      return reply
        .header('content-type', 'application/x-git-upload-pack-advertisement')
        .header('cache-control', 'no-cache')
        .send(Buffer.concat([Buffer.from(head), body]))
    }

    instance.get('/git/vaults/:vaultId/info/refs', advertise)

    instance.post('/git/vaults/:vaultId/git-upload-pack', { bodyLimit: MAX_REQUEST_BYTES }, async (req: FastifyRequest<{ Params: { vaultId: string } }>, reply) => {
      const vaultId = await authorise(req, reply)
      if (vaultId === null) return reply
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      let request = raw
      if (req.headers['content-encoding'] === 'gzip') {
        // Inflated under a cap: a few KiB of zeros must not become gigabytes.
        try {
          request = gunzipSync(raw, { maxOutputLength: MAX_REQUEST_BYTES })
        } catch {
          return reply.code(413).send({ error: 'request too large or not gzip' })
        }
      }
      const dir = await ensureVaultRemote(vaultId)
      return reply.header('content-type', 'application/x-git-upload-pack-result').header('cache-control', 'no-cache').send(await upload(dir, [], request))
    })
  })
}

/** `git upload-pack --stateless-rpc` on the repository at `dir`: its output for the request. */
function upload(dir: string, flags: string[], request: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['upload-pack', '--stateless-rpc', ...flags, dir], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
    const out: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git upload-pack exited ${code}`))))
    child.stdin.on('error', () => {})
    child.stdin.end(request)
  })
}
