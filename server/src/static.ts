import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { COLLAB_PATH } from './sync/routes.js'

/**
 * Serves the built client (`client/dist`) from the API process, with an SPA
 * history fallback so a deep link like `/vaults/x/notes/y` returns the shell.
 *
 * Optional by construction: with no built client on disk — every dev machine,
 * every existing test run — nothing is registered and the server behaves
 * exactly as it did before. The API must never be unstartable because the
 * frontend has not been built.
 */

// ponytail: hand-rolled rather than @fastify/static, which is not a dependency
// of this package and cannot be added from here. The SPA fallback needs a
// custom handler either way, so the whole thing is ~50 lines of node:fs.
// Ceiling: no ETag, no Range, no directory listings, no dotfile policy —
// swap in @fastify/static if any of those start to matter.

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/**
 * Paths the SPA shell must never answer for: everything a machine talks to.
 *
 * The not-found handler set on the root instance is inherited by the `/api`
 * plugin, so without this guard an unknown API route would return 200 + HTML:
 * every request appears to succeed while the client gets an unparseable body
 * for every error. `/collab` is reserved for the same reason — a proxy that
 * drops the `Upgrade` header should get a 404, not a page — and `/mcp`
 * because MCP transports probe it with GET and would parse a page as a
 * protocol response.
 *
 * `/repositories` is here too, and the reasoning that left it out was wrong:
 * the method check only rejects non-GET, so a GET to a POST-only machine route
 * still fell through to the shell. A git host's endpoint-verification GET, or
 * an uptime probe, would get 200 and a page of HTML — which reads as healthy
 * while the endpoint is not being exercised at all.
 */
const RESERVED = ['/api', COLLAB_PATH, '/mcp', '/repositories']

/**
 * `req.url` is usually origin-form (`/api/vaults`) but is legally absolute-form
 * (`http://host/api/vaults`) — some forward proxies emit it. Parsed against a
 * dummy base, both shapes collapse to the same pathname, so a request in the
 * second shape cannot walk past the guard below and be served the shell.
 */
export function pathnameOf(url: string): string {
  try {
    return new URL(url, 'http://x').pathname
  } catch {
    return url.split('?')[0] ?? url
  }
}

function isReserved(pathname: string): boolean {
  return RESERVED.some((base) => pathname === base || pathname.startsWith(`${base}/`))
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Resolves a request path inside `root`, or null if it escapes it. */
function safeJoin(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const target = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`)
  return target === root || target.startsWith(root + sep) ? target : null
}

function sendFile(reply: FastifyReply, file: string): FastifyReply {
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  // Vite content-hashes everything under assets/; the shell must never stick.
  const immutable = file.includes(`${sep}assets${sep}`)
  return reply
    .type(type)
    .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
    .send(createReadStream(file))
}

/**
 * Registers the static + SPA fallback handler. Returns false (and registers
 * nothing) when `dir` holds no `index.html`.
 */
export async function registerStatic(app: FastifyInstance, dir: string): Promise<boolean> {
  const root = resolve(dir)
  const index = join(root, 'index.html')
  if (!(await isFile(index))) return false

  app.setNotFoundHandler(async (req, reply) => {
    const pathname = pathnameOf(req.url)
    if (isReserved(pathname)) return reply.code(404).send({ error: 'not found' })
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send({ error: 'not found' })
    }
    const file = safeJoin(root, pathname)
    if (!file) return reply.code(404).send({ error: 'not found' })
    if (await isFile(file)) return sendFile(reply, file)
    return sendFile(reply, index)
  })

  console.log(`serving client from ${root}`)
  return true
}
