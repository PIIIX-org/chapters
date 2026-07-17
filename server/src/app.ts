import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { config } from './config.js'
import { authPlugin } from './auth/plugin.js'
import { authRoutes } from './auth/routes.js'
import { adminRoutes } from './auth/admin-routes.js'
import { vaultRoutes } from './vaults/routes.js'
import { noteRoutes } from './notes/routes.js'
import { graphRoutes } from './graph/routes.js'
import { searchRoutes } from './search/routes.js'
import { teamRoutes } from './vaults/team-routes.js'
import { mcpConnectionRoutes } from './vaults/mcp-connection-routes.js'
import { notificationRoutes } from './notifications/routes.js'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  await app.register(cookie)
  await app.register(rateLimit, {
    global: true,
    max: 1000,
    timeWindow: '1 minute',
  })
  await app.register(authPlugin)

  app.get('/health', () => ({ status: 'ok' }))

  await app.register(
    async (api) => {
      authRoutes(api, { isProd: config.isProd })
      await api.register(async (a) => notificationRoutes(a))
      await api.register(async (a) => vaultRoutes(a))
      await api.register(async (a) => noteRoutes(a))
      await api.register(async (a) => graphRoutes(a))
      await api.register(async (a) => searchRoutes(a))
      await api.register(async (a) => teamRoutes(a))
      await api.register(async (a) => mcpConnectionRoutes(a))
      await api.register(async (a) => adminRoutes(a), { prefix: '/admin' })
    },
    { prefix: '/api' },
  )

  return app
}
