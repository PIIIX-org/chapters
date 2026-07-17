import type { FastifyInstance } from 'fastify'
import { atLeast, resolveAccess } from '../vaults/permissions.js'
import { readNote, splitPath } from '../notes/store.js'
import { addViewer } from './viewers.js'

/**
 * Read-only live view: SSE stream of note states. Viewers get the same
 * real-time content as editors but never join the Yjs doc — no
 * awareness, no identity data, no cursor broadcast (audit rule).
 */
export function syncRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

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
