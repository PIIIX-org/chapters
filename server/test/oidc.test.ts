import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

/**
 * A minimal fake issuer: discovery, JWKS, and a token endpoint the test
 * scripts per call. The app must never know it is not Keycloak.
 */
const CLIENT_ID = 'chapters-test'
const CLIENT_SECRET = 'test-secret'

let issuer: Server
let issuerUrl: string
let keys: Awaited<ReturnType<typeof generateKeyPair>>
/** What the next /token call answers. Tests overwrite per case. */
let nextIdToken: () => Promise<string | null>
let lastTokenRequest: { auth: string | null; body: URLSearchParams } | null = null

let app: FastifyInstance
let db: typeof import('../src/db/client.js').db
let users: typeof import('../src/db/schema.js').users
let helpers: typeof import('./helpers.js')

function signIdToken(claims: Record<string, unknown>, overrides: { aud?: string; iss?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(overrides.iss ?? issuerUrl)
    .setAudience(overrides.aud ?? CLIENT_ID)
    .setSubject('subject-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey)
}

beforeAll(async () => {
  keys = await generateKeyPair('ES256', { extractable: true })
  issuer = createServer((req, res) => {
    void (async () => {
      if (req.url === '/.well-known/openid-configuration') {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            issuer: issuerUrl,
            authorization_endpoint: `${issuerUrl}/authorize`,
            token_endpoint: `${issuerUrl}/token`,
            jwks_uri: `${issuerUrl}/jwks`,
          }),
        )
      } else if (req.url === '/jwks') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' }] }))
      } else if (req.url === '/token') {
        let raw = ''
        req.on('data', (c: Buffer) => (raw += c.toString()))
        req.on('end', () => {
          void (async () => {
            lastTokenRequest = { auth: req.headers.authorization ?? null, body: new URLSearchParams(raw) }
            const idToken = await nextIdToken()
            res.setHeader('content-type', 'application/json')
            if (!idToken) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'invalid_grant' }))
            } else {
              res.end(JSON.stringify({ access_token: 'at', id_token: idToken, token_type: 'Bearer', expires_in: 900 }))
            }
          })()
        })
      } else {
        res.statusCode = 404
        res.end()
      }
    })()
  })
  await new Promise<void>((resolve) => issuer.listen(0, '127.0.0.1', resolve))
  const address = issuer.address()
  issuerUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  // The config getter reads env at access time — set before buildApp registers
  // routes, and import the app AFTER the issuer's port is known.
  process.env.OIDC_ISSUER = issuerUrl
  process.env.OIDC_CLIENT_ID = CLIENT_ID
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET
  delete process.env.OIDC_ONLY

  const [{ buildApp }, dbMod, schemaMod, helpersMod] = await Promise.all([
    import('../src/app.js'),
    import('../src/db/client.js'),
    import('../src/db/schema.js'),
    import('./helpers.js'),
  ])
  db = dbMod.db
  users = schemaMod.users
  helpers = helpersMod
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  delete process.env.OIDC_ISSUER
  delete process.env.OIDC_CLIENT_ID
  delete process.env.OIDC_CLIENT_SECRET
  delete process.env.OIDC_ONLY
  await app.close()
  await new Promise((resolve) => issuer.close(resolve))
})

/** Runs /api/oidc/login and returns everything the callback leg needs. */
async function startLogin() {
  const res = await app.inject({ method: 'GET', url: '/api/oidc/login' })
  expect(res.statusCode).toBe(302)
  const location = new URL(res.headers.location as string)
  const cookie = res.cookies.find((c) => c.name === 'oidc_txn')!
  expect(cookie).toBeTruthy()
  return {
    cookie: { oidc_txn: cookie.value },
    state: location.searchParams.get('state')!,
    nonce: location.searchParams.get('nonce')!,
    challenge: location.searchParams.get('code_challenge')!,
    location,
  }
}

describe('OIDC login', () => {
  it('advertises its configuration to the login page', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth-config' })
    expect(res.json()).toEqual({ oidc: true, oidcOnly: false })
  })

  it('starts the flow with PKCE S256, state and nonce', async () => {
    const { location, state, nonce, challenge } = await startLogin()
    expect(location.origin).toBe(issuerUrl)
    expect(location.pathname).toBe('/authorize')
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(state).toBeTruthy()
    expect(nonce).toBeTruthy()
    expect(challenge).toBeTruthy()
  })

  it('provisions a new user from claims and signs them in', async () => {
    const email = helpers.uniqueEmail('oidc-new')
    const txn = await startLogin()
    nextIdToken = () => signIdToken({ email, nonce: txn.nonce })

    const res = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=code-1&state=${txn.state}`,
      cookies: txn.cookie,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
    expect(res.cookies.find((c) => c.name === 'sid')).toBeTruthy()

    // The token exchange authenticated and carried the PKCE verifier.
    expect(lastTokenRequest!.auth).toBe('Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'))
    const verifier = lastTokenRequest!.body.get('code_verifier')!
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(txn.challenge)

    const [user] = await db.select().from(users).where(eq(users.email, email))
    expect(user).toBeTruthy()
    expect(user!.status).toBe('active')
    expect(user!.emailVerifiedAt).toBeTruthy()
    expect(user!.role).toBe('member')
  })

  it('links to the existing user by email instead of creating a second one', async () => {
    const existing = await helpers.createActiveUser({ role: 'admin' })
    const txn = await startLogin()
    nextIdToken = () => signIdToken({ email: existing.email, nonce: txn.nonce })

    const res = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=code-2&state=${txn.state}`,
      cookies: txn.cookie,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')

    const rows = await db.select().from(users).where(eq(users.email, existing.email))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(existing.id)
    expect(rows[0]!.role).toBe('admin')
  })

  it('rejects a state that does not match the transaction cookie', async () => {
    const txn = await startLogin()
    nextIdToken = () => signIdToken({ email: helpers.uniqueEmail(), nonce: txn.nonce })
    const res = await app.inject({
      method: 'GET',
      url: '/auth/callback?code=code-3&state=wrong',
      cookies: txn.cookie,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/login?error=sso')
    expect(res.cookies.find((c) => c.name === 'sid')).toBeUndefined()
  })

  it('rejects an id_token whose nonce does not match', async () => {
    const txn = await startLogin()
    nextIdToken = () => signIdToken({ email: helpers.uniqueEmail(), nonce: 'stolen' })
    const res = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=code-4&state=${txn.state}`,
      cookies: txn.cookie,
    })
    expect(res.headers.location).toBe('/login?error=sso')
  })

  it('rejects an id_token for a different audience', async () => {
    const txn = await startLogin()
    nextIdToken = () => signIdToken({ email: helpers.uniqueEmail(), nonce: txn.nonce }, { aud: 'someone-else' })
    const res = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=code-5&state=${txn.state}`,
      cookies: txn.cookie,
    })
    expect(res.headers.location).toBe('/login?error=sso')
  })

  it('rejects an explicitly unverified email claim', async () => {
    const txn = await startLogin()
    nextIdToken = () => signIdToken({ email: helpers.uniqueEmail(), email_verified: false, nonce: txn.nonce })
    const res = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=code-6&state=${txn.state}`,
      cookies: txn.cookie,
    })
    expect(res.headers.location).toBe('/login?error=sso')
  })

  it('refuses to sign in a non-active account', async () => {
    const pending = await helpers.createActiveUser({ status: 'pending_approval' })
    const txn = await startLogin()
    nextIdToken = () => signIdToken({ email: pending.email, nonce: txn.nonce })
    const res = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=code-7&state=${txn.state}`,
      cookies: txn.cookie,
    })
    expect(res.headers.location).toBe('/login?error=sso')
  })

  it('OIDC_ONLY=true disables every password surface', async () => {
    process.env.OIDC_ONLY = 'true'
    try {
      const config = await app.inject({ method: 'GET', url: '/api/auth-config' })
      expect(config.json()).toEqual({ oidc: true, oidcOnly: true })

      const user = await helpers.createActiveUser()
      for (const [url, body] of [
        ['/api/login', { email: user.email, password: helpers.TEST_PASSWORD }],
        ['/api/signup', { email: helpers.uniqueEmail(), password: helpers.TEST_PASSWORD }],
        ['/api/request-password-reset', { email: user.email }],
        ['/api/reset-password', { token: 'x'.repeat(32), password: helpers.TEST_PASSWORD }],
      ] as const) {
        const res = await app.inject({ method: 'POST', url, body })
        expect(res.statusCode, url).toBe(403)
        expect(res.json().error).toMatch(/single sign-on/)
      }
    } finally {
      delete process.env.OIDC_ONLY
    }
  })
})
