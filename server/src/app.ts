import Fastify, { type FastifyInstance, type FastifyServerOptions, type FastifyError } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { config } from './config.js'
import { registerStatic } from './static.js'
import { sql } from './db/client.js'
import { bootInfo } from './lifecycle.js'
import { authPlugin } from './auth/plugin.js'
import { authRoutes } from './auth/routes.js'
import { oidcRoutes } from './auth/oidc-routes.js'
import { accountRoutes } from './auth/account-routes.js'
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
import { repositoryPushRoutes } from './repositories/push-routes.js'
import { repositoryWebhookRoutes } from './repositories/git-webhook-routes.js'
import { repositoryFileContentRoutes } from './repositories/file-content-routes.js'
import { recordRequest } from './monitoring/metrics.js'
import { monitoringRoutes } from './monitoring/routes.js'

export async function buildApp(
  opts: { clientDist?: string; logger?: FastifyServerOptions['logger'] } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger !== undefined
        ? opts.logger
        : config.isTest
          ? false
          : { level: config.isProd ? 'info' : 'debug' },
  })

  // Every finished request is counted per route template, and a 5xx is
  // reported with the error's class name and code, never its message
  // (monitoring/metrics.ts, #705). The error handler hands the error over.
  const serverErrors = new WeakMap<object, unknown>()
  app.addHook('onResponse', (req, reply, done) => {
    recordRequest({
      method: req.method,
      template: req.routeOptions.url,
      status: reply.statusCode,
      durationMs: reply.elapsedTime,
      reqId: req.id,
      actor: req.user ? 'user' : /^Bearer /i.test(req.headers.authorization ?? '') ? 'token' : 'anonymous',
      error: serverErrors.get(req),
    })
    done()
  })

  app.setErrorHandler((error: FastifyError, req, reply) => {
    if ((error as { code?: string }).code === '22P02') {
      return reply.code(404).send({ error: 'not found' })
    }
    const statusCode = error.statusCode ?? 500
    if (statusCode >= 500) {
      serverErrors.set(req, error)
      req.log.error(error)
    } else {
      req.log.info({ err: error }, error.message)
    }
    // A 5xx message is hidden in production unless the error says it is safe to show (`expose`, e.g. StoreBusyError).
    const exposed = 'expose' in error && error.expose === true
    const message =
      statusCode >= 500 && config.isProd && !exposed
        ? 'Internal server error'
        : error.message || 'Internal server error'
    return reply.code(statusCode).send({
      statusCode,
      error: message,
      message,
    })
  })

  // The CSP is spelled out rather than left to helmet's defaults because this
  // app now serves an HTML document, not just JSON. Two defaults are wrong for
  // a self-hosted product:
  //
  // - `upgrade-insecure-requests` rewrites every request to https. On a LAN or
  //   intranet instance served over plain http — the ordinary self-hosted
  //   case — that turns a working deployment into a blank page.
  // - `connect-src` must allow the websocket scheme, or the collaboration
  //   relay is blocked by the very policy meant to protect it.
  //
  // Fonts come from Google Fonts (the design system's Petrona / Hanken Grotesk
  // / IBM Plex Mono), so those two hosts are named explicitly rather than
  // opened up with a wildcard.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'blob:'],
        // ws: and wss: so the relay works on both http and https origins.
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'upgrade-insecure-requests': null,
      },
    },
  })
  // Same-origin only when unconfigured — no CORS registration at all is
  // the correct default for a self-hosted app whose UI is expected to be
  // reverse-proxied under the same origin as the API.
  if (config.corsOrigins.length > 0) {
    await app.register(cors, { origin: config.corsOrigins, credentials: true })
  }
  await app.register(cookie)
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } })
  await app.register(rateLimit, {
    global: true,
    max: 1000,
    timeWindow: '1 minute',
  })
  await app.register(authPlugin)

  // Unauthenticated, so it carries nothing sensitive: the process identity
  // (lifecycle.ts) lets an outside monitor see a restart (#583).
  // ELARA_HEALTH_HIDE_VERSION=true leaves out the build commit (#638).
  app.get('/health', async (_req, reply) => {
    try {
      await sql`SELECT 1`
      const { version, ...identity } = bootInfo()
      return config.healthHidesVersion ? { status: 'ok', ...identity } : { status: 'ok', ...identity, version }
    } catch (err) {
      app.log.error(err, 'Health check database failure')
      return reply.code(503).send({ status: 'error', error: 'Database unreachable' })
    }
  })

  mcpRoutes(app)
  repositoryPushRoutes(app)
  repositoryWebhookRoutes(app)
  // Root-level, not under /api: issuers redirect back to /auth/callback.
  oidcRoutes(app, { isProd: config.isProd })

  await app.register(
    async (api) => {
      authRoutes(api, { isProd: config.isProd })
      await api.register(async (a) => accountRoutes(a))
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
      await api.register(async (a) => repositoryFileContentRoutes(a))
      await api.register(async (a) => mcpConnectionRoutes(a))
      await api.register(async (a) => adminRoutes(a), { prefix: '/admin' })
      await api.register(async (a) => adminDashboardRoutes(a), { prefix: '/admin' })
      await api.register(async (a) => monitoringRoutes(a), { prefix: '/admin' })
    },
    { prefix: '/api' },
  )

  // Last, and only if a built client exists: the SPA fallback answers what the
  // routes above did not. It never sees `/api/*` or `/collab` — see static.ts.
  await registerStatic(app, opts.clientDist ?? config.clientDist)

  return app
}
