import type { FastifyInstance, FastifyReply } from 'fastify'
import { listAccessibleRepositories, resolveRepositoryAccess } from './permissions.js'
import { atLeast, listAccessibleVaults, resolveAccess } from '../vaults/permissions.js'
import { GrepError, MAX_CONTEXT, PAGE_HITS, encodePosition, grep, grepTargets, parsePosition } from './grep.js'
import { repositoryIndexedVersion } from './store.js'

/**
 * `GET /vaults/:id/grep`, `GET /repositories/:id/grep` and `GET /grep` (every
 * vault and repository the caller reaches), the REST face of MCP `grep` (#468;
 * repositories/grep.ts has the rules): `pattern`, `path` (glob), `context`,
 * `after` (the `next` of the previous page). The answer is
 * `{scanned, commit | tree?, hits, next, capped}`: the hits as MCP lists them
 * (`path`, `line`, `lines?`, `block?`, `tokens?`, `snippet`), `next` the
 * cursor of the following page or null, `capped` the path a stopped scan had
 * read to (its `next` continues). A refused pattern is 400, a scan past its
 * time limit 503.
 */
interface GrepQuery {
  pattern: string
  path?: string
  context?: number
  after?: string
}

const querySchema = {
  type: 'object',
  required: ['pattern'],
  properties: {
    pattern: { type: 'string', minLength: 1 },
    path: { type: 'string' },
    context: { type: 'integer', minimum: 0, maximum: MAX_CONTEXT },
    after: { type: 'string' },
  },
} as const

export function grepRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  async function answer(reply: FastifyReply, resources: { vaultIds: string[]; repositoryIds: string[] }, query: GrepQuery) {
    const after = query.after === undefined ? null : parsePosition(query.after)
    if (query.after !== undefined && after === null) return reply.code(400).send({ error: 'after is not a cursor of this route' })
    try {
      const found = await grep(await grepTargets(resources.vaultIds, resources.repositoryIds), {
        pattern: query.pattern,
        glob: query.path,
        context: query.context ?? 0,
        limit: PAGE_HITS,
        after,
      })
      const single = resources.vaultIds.length === 0 && resources.repositoryIds.length === 1 ? resources.repositoryIds[0]! : null
      const resume = found.more ? found.positions.at(-1) : found.capped
      return {
        scanned: found.scanned.files,
        ...(single ? await repositoryIndexedVersion(single) : {}),
        hits: found.hits,
        next: resume ? encodePosition(resume) : null,
        capped: found.capped ? found.capped.path : null,
      }
    } catch (err) {
      if (err instanceof GrepError) return reply.code(err.code === 'BUSY' ? 503 : 400).send({ error: err.message })
      throw err
    }
  }

  app.get<{ Params: { id: string }; Querystring: GrepQuery }>('/vaults/:id/grep', { schema: { querystring: querySchema } }, async (req, reply) => {
    if (!atLeast(await resolveAccess(req.user!.id, req.params.id), 'read')) return reply.code(404).send({ error: 'not found' })
    return answer(reply, { vaultIds: [req.params.id], repositoryIds: [] }, req.query)
  })

  app.get<{ Params: { id: string }; Querystring: GrepQuery }>('/repositories/:id/grep', { schema: { querystring: querySchema } }, async (req, reply) => {
    if (!(await resolveRepositoryAccess(req.user!.id, req.params.id))) return reply.code(404).send({ error: 'not found' })
    return answer(reply, { vaultIds: [], repositoryIds: [req.params.id] }, req.query)
  })

  app.get<{ Querystring: GrepQuery }>('/grep', { schema: { querystring: querySchema } }, async (req, reply) => {
    const [vaults, repositories] = await Promise.all([listAccessibleVaults(req.user!.id), listAccessibleRepositories(req.user!.id)])
    return answer(reply, { vaultIds: vaults.map((v) => v.id), repositoryIds: repositories.map((r) => r.id) }, req.query)
  })
}
