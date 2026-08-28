import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'

/**
 * Task 2 of the deployable plan: one process serves the built client too.
 * The dangerous half is not "does index.html come back" — it is everything
 * the SPA shell must NOT answer for.
 */

const SHELL = '<!doctype html><title>Chapters</title><div id="root"></div>'
const BUNDLE = 'console.log("client bundle")'

let dist: string
let outside: string
let app: FastifyInstance
/** Same app built against a directory with no client in it. */
let apiOnly: FastifyInstance

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'chapters-dist-'))
  dist = join(base, 'dist')
  outside = join(base, 'secret.txt')
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'index.html'), SHELL)
  await writeFile(join(dist, 'assets', 'app-a1b2c3.js'), BUNDLE)
  await writeFile(outside, 'NOT-SERVABLE')

  app = await buildApp({ clientDist: dist })
  apiOnly = await buildApp({ clientDist: join(base, 'never-built') })
})

afterAll(async () => {
  await app.close()
  await apiOnly.close()
  await rm(join(dist, '..'), { recursive: true, force: true })
})

describe('serving the built client', () => {
  it('serves the shell at the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toBe(SHELL)
  })

  it('serves the shell for a deep client route (SPA history fallback)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/vaults/v1/notes/docs/my.note',
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(SHELL)
  })

  it('serves a hashed asset as itself, immutably cached', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/assets/app-a1b2c3.js',
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(BUNDLE)
    expect(res.headers['content-type']).toContain('text/javascript')
    expect(res.headers['cache-control']).toContain('immutable')
  })

  it('never caches the shell itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('refuses a path that escapes the client directory', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/assets/..%2f..%2fsecret.txt',
    })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('NOT-SERVABLE')
  })
})

describe('what the SPA shell must never answer for', () => {
  it('404s an unknown API route as JSON, not as the shell', async () => {
    // The catastrophic ordering bug: a root not-found handler is inherited by
    // the /api plugin, so without the guard every API error becomes 200 HTML
    // and the client can never parse a failure again.
    const res = await app.inject({
      method: 'GET',
      url: '/api/definitely-not-a-route',
    })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.body).not.toContain('<!doctype html>')
    expect(res.json()).toEqual({ error: 'not found' })
  })

  it('404s an unknown API route on a non-GET method too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/definitely-not-a-route',
    })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('<!doctype html>')
  })

  it('never answers a non-GET request with the shell', async () => {
    // A mistyped POST to a client route returning 200 HTML reads as success
    // to anything that only checks the status.
    const res = await app.inject({
      method: 'POST',
      url: '/vaults/v1/notes/docs/x',
    })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('<!doctype html>')
  })

  it('leaves a real API route alone', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/vaults' })
    expect(res.statusCode).toBe(401)
    expect(res.body).not.toContain('<!doctype html>')
  })

  it('does not swallow /collab', async () => {
    // The websocket upgrade never reaches Fastify's router, but a proxy that
    // drops the Upgrade header must get a 404 — not a page that looks fine.
    const res = await app.inject({ method: 'GET', url: '/collab' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('<!doctype html>')
  })

  it('does not swallow /mcp', async () => {
    // MCP's streamable-HTTP transport GETs this path; a 200 page would be
    // parsed as a protocol response.
    const res = await app.inject({ method: 'GET', url: '/mcp' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('<!doctype html>')
  })

  it('leaves /health alone', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toEqual({ status: 'ok' })
  })
})

describe('with no built client', () => {
  it('starts and serves the API exactly as before', async () => {
    expect(
      (await apiOnly.inject({ method: 'GET', url: '/health' })).statusCode,
    ).toBe(200)
    expect(
      (await apiOnly.inject({ method: 'GET', url: '/api/vaults' })).statusCode,
    ).toBe(401)
  })

  it('404s the root instead of inventing a shell', async () => {
    const res = await apiOnly.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('<!doctype html>')
  })
  it('404s a GET to a POST-only machine route instead of answering with the shell', async () => {
    // The method guard only rejects non-GET, so these fell through: a git
    // host's endpoint-verification GET, or an uptime probe, got 200 and a page
    // of HTML. That reads as healthy while the endpoint is never exercised.
    for (const url of ['/repositories/sync', '/repositories/some-id/webhook']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, `${url} answered with the shell`).not.toBe(200)
      expect(res.body).not.toContain('<!doctype html')
    }
  })

  it('cannot be walked past with an absolute-form request URI', async () => {
    // `GET http://host/api/vaults HTTP/1.1` is legal and some forward proxies
    // emit it. Compared verbatim it does not start with '/api', so the guard
    // missed it and an API path was served the HTML shell.
    //
    // This goes over a real socket on purpose: `app.inject` normalises the URL
    // to a path before the handler sees it, so an inject-based version of this
    // test passes whether or not the fix is present. It was written that way
    // first and caught being vacuous by mutation.
    // Its own instance: listening on and closing the shared `app` would leave
    // every test after this one with a closed Fastify.
    const listener = await buildApp({ clientDist: dist })
    await listener.listen({ port: 0, host: '127.0.0.1' })
    try {
      const address = listener.server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const net = await import('node:net')

      const response = await new Promise<string>((resolve, reject) => {
        let buf = ''
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(
            'GET http://chapters.test/api/definitely-not-a-route HTTP/1.1\r\n' +
              'Host: chapters.test\r\nConnection: close\r\n\r\n',
          )
        })
        socket.on('data', (d) => (buf += d.toString()))
        socket.on('end', () => resolve(buf))
        socket.on('error', reject)
      })

      expect(response).not.toContain('<!doctype html')
      expect(response.split('\r\n')[0]).not.toContain('200')
    } finally {
      await listener.close()
    }
  })

  it('sets a CSP that does not break a plain-http instance or the relay', async () => {
    // helmet's defaults now decorate an HTML document for the first time.
    // `upgrade-insecure-requests` rewrites every request to https, which turns
    // an ordinary LAN self-hosted deployment into a blank page; and connect-src
    // must permit the websocket or the relay is blocked by the very policy
    // meant to protect it.
    const csp = (await app.inject({ method: 'GET', url: '/' })).headers[
      'content-security-policy'
    ]
    expect(csp).toBeDefined()
    expect(String(csp)).not.toContain('upgrade-insecure-requests')
    expect(String(csp)).toMatch(/connect-src[^;]*ws:/)
  })
})
