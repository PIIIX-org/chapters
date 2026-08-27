import type { FastifyInstance } from 'fastify'
import { atLeast, resolveAccess } from '../vaults/permissions.js'
import { readNote, splitPath } from '../notes/store.js'
import { addViewer } from './viewers.js'
import { issueTicket } from './tickets.js'

/**
 * Where the browser should connect to the relay: **the page's own origin, at
 * `/collab`**.
 *
 * The relay rides this same HTTP server: the `upgrade` event on `/collab` is
 * handed to Hocuspocus, so there is no second port and nothing to route. That
 * is why this returns a path and not a URL — the server cannot know the origin
 * the browser used (behind vite it sees `localhost:3000`, behind nginx it sees
 * the proxy), and guessing produced `ws://localhost:3000/collab`: the API
 * port, which 404'd every handshake. The browser resolves it against the
 * origin it loaded from, which is the one origin guaranteed to reach back.
 *
 * Dev has the same route in `client/vite.config.ts`, so the one URL is correct
 * in both — `collab-ticket.test.ts` connects over `/collab` to prove the relay
 * accepts the forwarded path.
 *
 * The host comes from the request because it is what the browser typed; the
 * port stays on it (dev is `localhost:5173`, and vite forwards the Host header
 * unchanged).
 */
/**
 * The relay's path, NOT an absolute URL — the client resolves it against its
 * own origin.
 *
 * This used to build an absolute URL from the `host` header, which is wrong
 * everywhere there is a proxy in front, and there always is: in dev, vite
 * forwards `/api` to :3000 and fastify sees `localhost:3000`, so the browser
 * was handed `ws://localhost:3000/collab` — the API port, which has no relay
 * on it, and every editor got a 404 handshake. The same shape breaks behind
 * nginx, and reading `x-forwarded-host` only moves the guess.
 *
 * The browser already knows the origin it loaded from, and that is the one
 * origin guaranteed to reach back through whatever proxy served the page. So
 * the server names the path and the client supplies the rest.
 */
export const COLLAB_PATH = '/collab'

/**
 * Read-only live view: SSE stream of note states. Viewers get the same
 * real-time content as editors but never join the Yjs doc — no
 * awareness, no identity data, no cursor broadcast (audit rule).
 */
export function syncRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  /**
   * Mints the websocket credential (`client/src/api/collab.ts` is written
   * against this shape). Authentication only — no vault is named here, and a
   * ticket confers no permission: the relay still resolves live access on
   * connect and on every inbound message.
   */
  app.post('/collab/ticket', async (req) => {
    const { token, expiresAt } = issueTicket(req.user!.id)
    return { token, url: COLLAB_PATH, expiresAt: expiresAt.toISOString() }
  })

  app.get<{ Params: { id: string; '*': string } }>(
    '/vaults/:id/live/*',
    async (req, reply) => {
      const vaultId = req.params.id
      const path = req.params['*']
      const access = await resolveAccess(req.user!.id, vaultId)
      if (!atLeast(access, 'read')) return reply.code(404).send({ error: 'not found' })
      splitPath(path)
      const note = await readNote(vaultId, path)
      if (!note) return reply.code(404).send({ error: 'note not found' })

      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      reply.raw.write(
        `data: ${JSON.stringify({ frontmatter: note.frontmatter, body: note.body })}\n\n`,
      )
      addViewer({ userId: req.user!.id, vaultId, path, reply })
    },
  )
}
