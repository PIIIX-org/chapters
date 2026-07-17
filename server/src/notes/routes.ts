import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { atLeast, resolveAccess, type Access } from '../vaults/permissions.js'
import { OkfValidationError } from './okf.js'
import {
  createNote,
  listNotes,
  listTrash,
  readNote,
  renameNote,
  restoreNote,
  softDeleteNote,
  splitPath,
  updateNote,
} from './store.js'

type VaultReq = FastifyRequest<{ Params: { id: string; '*': string } }>

/** Resolves access or replies 404 — no access must be indistinguishable from no vault. */
async function guard(req: VaultReq, reply: FastifyReply, needed: Access): Promise<boolean> {
  const access = await resolveAccess(req.user!.id, req.params.id)
  if (!atLeast(access, needed)) {
    await reply.code(404).send({ error: 'not found' })
    return false
  }
  return true
}

export function noteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof OkfValidationError) {
      return reply.code(err.message.includes('already exists') ? 409 : 400).send({ error: err.message })
    }
    throw err
  })

  app.get<{ Params: { id: string; '*': string } }>('/vaults/:id/tree', async (req, reply) => {
    if (!(await guard(req as VaultReq, reply, 'read'))) return
    const rows = await listNotes(req.params.id)
    const byType: Record<string, typeof rows> = {}
    for (const row of rows) (byType[row.type] ??= []).push(row)
    return byType
  })

  app.post<{
    Params: { id: string; '*': string }
    Body: { type: string; name: string; frontmatter?: Record<string, unknown>; body?: string }
  }>(
    '/vaults/:id/notes',
    {
      schema: {
        body: {
          type: 'object',
          required: ['type', 'name'],
          properties: {
            type: { type: 'string', minLength: 1, maxLength: 100 },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            frontmatter: { type: 'object' },
            body: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!(await guard(req as VaultReq, reply, 'edit'))) return
      return createNote(req.params.id, req.body)
    },
  )

  app.get<{ Params: { id: string; '*': string } }>('/vaults/:id/notes/*', async (req, reply) => {
    if (!(await guard(req, reply, 'read'))) return
    splitPath(req.params['*'])
    const note = await readNote(req.params.id, req.params['*'])
    if (!note) return reply.code(404).send({ error: 'note not found' })
    return { path: note.row.path, frontmatter: note.frontmatter, body: note.body, updatedAt: note.row.updatedAt }
  })

  app.put<{
    Params: { id: string; '*': string }
    Body: { frontmatter?: Record<string, unknown>; body?: string }
  }>(
    '/vaults/:id/notes/*',
    {
      schema: {
        body: {
          type: 'object',
          properties: { frontmatter: { type: 'object' }, body: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      if (!(await guard(req, reply, 'edit'))) return
      splitPath(req.params['*'])
      const updated = await updateNote(req.params.id, req.params['*'], req.body)
      if (!updated) return reply.code(404).send({ error: 'note not found' })
      return updated
    },
  )

  app.post<{ Params: { id: string; '*': string }; Body: { from: string; to: string } }>(
    '/vaults/:id/notes-rename',
    {
      schema: {
        body: {
          type: 'object',
          required: ['from', 'to'],
          properties: {
            from: { type: 'string' },
            to: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!(await guard(req as VaultReq, reply, 'edit'))) return
      splitPath(req.body.from)
      const renamed = await renameNote(req.params.id, req.body.from, req.body.to)
      if (!renamed) return reply.code(404).send({ error: 'note not found' })
      return renamed
    },
  )

  app.delete<{ Params: { id: string; '*': string } }>(
    '/vaults/:id/notes/*',
    async (req, reply) => {
      if (!(await guard(req, reply, 'edit'))) return
      splitPath(req.params['*'])
      const deleted = await softDeleteNote(req.params.id, req.params['*'])
      if (!deleted) return reply.code(404).send({ error: 'note not found' })
      return { status: 'trashed', id: deleted.id }
    },
  )

  app.get<{ Params: { id: string; '*': string } }>('/vaults/:id/trash', async (req, reply) => {
    if (!(await guard(req as VaultReq, reply, 'edit'))) return
    return listTrash(req.params.id)
  })

  app.post<{ Params: { id: string; noteId: string; '*': string } }>(
    '/vaults/:id/trash/:noteId/restore',
    async (req, reply) => {
      if (!(await guard(req as unknown as VaultReq, reply, 'edit'))) return
      const restored = await restoreNote(req.params.id, req.params.noteId)
      if (!restored) return reply.code(404).send({ error: 'trashed note not found' })
      return restored
    },
  )
}
