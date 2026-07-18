import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { config } from './config.js'
import { authPlugin } from './auth/plugin.js'
import { authRoutes } from './auth/routes.js'
import { adminRoutes } from './auth/admin-routes.js'
import { adminDashboardRoutes } from './auth/admin-dashboard-routes.js'
import { mfaRoutes } from './auth/mfa-routes.js'
import { vaultRoutes } from './vaults/routes.js'
import { noteRoutes } from './notes/routes.js'
import { graphRoutes } from './graph/routes.js'
import { searchRoutes } from './search/routes.js'
import { syncRoutes } from './sync/routes.js'
import { mcpRoutes } from './mcp/routes.js'
import { exportRoutes } from './export/routes.js'
import { teamRoutes } from './vaults/team-routes.js'
import { mcpConnectionRoutes } from './vaults/mcp-connection-routes.js'
import { notificationRoutes } from './notifications/routes.js'
import { repositoryRoutes } from './repositories/routes.js'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  await app.register(cookie)
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } })
  await app.register(rateLimit, {
    global: true,
    max: 1000,
    timeWindow: '1 minute',
  })
  await app.register(authPlugin)

  app.get('/health', () => ({ status: 'ok' }))

  mcpRoutes(app)

  await app.register(
    async (api) => {
      authRoutes(api, { isProd: config.isProd })
      await api.register(async (a) => notificationRoutes(a))
      await api.register(async (a) => mfaRoutes(a))
      await api.register(async (a) => vaultRoutes(a))
      await api.register(async (a) => noteRoutes(a))
      await api.register(async (a) => graphRoutes(a))
      await api.register(async (a) => searchRoutes(a))
      await api.register(async (a) => syncRoutes(a))
      await api.register(async (a) => exportRoutes(a))
      await api.register(async (a) => teamRoutes(a))
      await api.register(async (a) => repositoryRoutes(a))
      await api.register(async (a) => mcpConnectionRoutes(a))
      await api.register(async (a) => adminRoutes(a), { prefix: '/admin' })
      await api.register(async (a) => adminDashboardRoutes(a), { prefix: '/admin' })
    },
    { prefix: '/api' },
  )

  return app
}
