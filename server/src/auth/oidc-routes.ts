import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { hashPassword } from './passwords.js'
import { createSession } from './sessions.js'
import { logSecurityEvent } from './security-events.js'
import { SESSION_COOKIE } from './plugin.js'
import { sessionCookieOptions, strictRateLimit } from './routes.js'

/**
 * OIDC relying-party login. The app's entire knowledge of an identity
 * provider is the three OIDC_* env vars — it must never learn which product
 * runs the issuer. Authorization code flow with PKCE only.
 */

/** Carries state/nonce/verifier across the redirect round-trip. */
const TXN_COOKIE = 'oidc_txn'
const TXN_TTL_S = 10 * 60

interface IssuerMeta {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

let cached: { issuer: string; meta: IssuerMeta; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null

/** Discovery + JWKS, fetched once per issuer and cached for the process. */
async function discover(issuer: string) {
  if (cached?.issuer !== issuer) {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`)
    if (!res.ok) throw new Error(`OIDC discovery failed with ${res.status}`)
    const meta = (await res.json()) as IssuerMeta
    cached = { issuer, meta, jwks: createRemoteJWKSet(new URL(meta.jwks_uri)) }
  }
  return cached
}

/**
 * The exact redirect URI registered with the issuer. Behind the reverse proxy
 * that hosted instances always sit behind, `req.protocol` is the backend leg
 * (http) — trust x-forwarded-proto, as the collab ticket learned the hard way.
 */
function callbackUrl(req: FastifyRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol
  return `${proto}://${req.headers.host}/auth/callback`
}

export function oidcRoutes(app: FastifyInstance, opts: { isProd: boolean }): void {
  const txnCookieOpts = {
    path: '/',
    httpOnly: true,
    secure: opts.isProd,
    sameSite: 'lax' as const,
    maxAge: TXN_TTL_S,
  }

  /** Public: the login page asks this before deciding what to render. */
  app.get('/api/auth-config', async () => ({
    oidc: config.oidc !== null,
    oidcOnly: config.oidc?.only ?? false,
  }))

  app.get('/api/oidc/login', { config: strictRateLimit }, async (req, reply) => {
    const oidc = config.oidc
    if (!oidc) return reply.code(404).send({ error: 'OIDC login is not configured' })
    const { meta } = await discover(oidc.issuer)

    const state = randomBytes(16).toString('base64url')
    const nonce = randomBytes(16).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')

    const url = new URL(meta.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', oidc.clientId)
    url.searchParams.set('redirect_uri', callbackUrl(req))
    url.searchParams.set('scope', 'openid email')
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
    url.searchParams.set('code_challenge_method', 'S256')

    const txn = Buffer.from(JSON.stringify({ state, nonce, verifier })).toString('base64url')
    return reply.setCookie(TXN_COOKIE, txn, txnCookieOpts).redirect(url.toString(), 302)
  })

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/callback',
    { config: strictRateLimit },
    async (req, reply) => {
      const oidc = config.oidc
      if (!oidc) return reply.code(404).send({ error: 'OIDC login is not configured' })

      // Browser-facing: every failure lands back on the login page with one
      // generic marker. The reason goes to the security log, not the URL.
      const fail = async (detail: string) => {
        await logSecurityEvent({ type: 'oidc_login_failed', ip: req.ip, detail: { reason: detail } })
        return reply.clearCookie(TXN_COOKIE, { path: '/' }).redirect('/login?error=sso', 302)
      }

      let txn: { state: string; nonce: string; verifier: string } | null = null
      try {
        txn = JSON.parse(Buffer.from(req.cookies[TXN_COOKIE] ?? '', 'base64url').toString())
      } catch {
        txn = null
      }
      if (!txn || !req.query.code || !req.query.state || req.query.state !== txn.state) {
        return fail('state mismatch or missing transaction')
      }

      const { meta, jwks } = await discover(oidc.issuer)
      const tokenRes = await fetch(meta.token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization:
            'Basic ' + Buffer.from(`${oidc.clientId}:${oidc.clientSecret}`).toString('base64'),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: req.query.code,
          redirect_uri: callbackUrl(req),
          code_verifier: txn.verifier,
        }),
      })
      if (!tokenRes.ok) return fail(`token exchange returned ${tokenRes.status}`)
      const { id_token } = (await tokenRes.json()) as { id_token?: string }
      if (!id_token) return fail('token response had no id_token')

      let payload
      try {
        ;({ payload } = await jwtVerify(id_token, jwks, {
          issuer: oidc.issuer,
          audience: oidc.clientId,
        }))
      } catch {
        return fail('id_token verification failed')
      }
      if (payload.nonce !== txn.nonce) return fail('nonce mismatch')

      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null
      // An issuer that does not assert email_verified is trusted (it was
      // configured by the operator); one that asserts false is not.
      if (!email || payload.email_verified === false) return fail('no verified email claim')

      // LINK by verified email before creating: on a provisioned instance the
      // setup-created admin already holds this address, and a second row would
      // strand the org behind an admin account nobody can reach.
      let user = (await db.select().from(users).where(eq(users.email, email)))[0]
      if (user) {
        if (user.status !== 'active') return fail('account is not active')
        if (!user.emailVerifiedAt) {
          await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id))
        }
      } else {
        // First login provisions the local user from claims. The password
        // column is NOT NULL and must never work: hash of entropy nobody holds.
        ;[user] = await db
          .insert(users)
          .values({
            email,
            passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
            status: 'active',
            role: 'member',
            emailVerifiedAt: new Date(),
          })
          .returning()
      }

      await logSecurityEvent({ type: 'oidc_login', subjectUserId: user!.id, ip: req.ip })
      const token = await createSession(user!.id)
      return reply
        .clearCookie(TXN_COOKIE, { path: '/' })
        .setCookie(SESSION_COOKIE, token, sessionCookieOptions(opts.isProd))
        .redirect('/', 302)
    },
  )
}
