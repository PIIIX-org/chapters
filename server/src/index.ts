import { buildApp } from './app.js'
import { startCollabServer } from './sync/collab-server.js'
import { runMigrations } from './db/migrate.js'
import { ensureInstanceState } from './auth/bootstrap.js'
import { scheduleMissingEmbeddings } from './search/embedding-queue.js'
import { startLocalWatchers, startPollingScheduler } from './repositories/scheduler.js'
import { config } from './config.js'
import { COLLAB_PATH } from './sync/routes.js'

const app = await buildApp()

try {
  await runMigrations()
  const missing = await scheduleMissingEmbeddings()
  if (missing > 0) console.log(`embedding catch-up scheduled for ${missing} notes`)
  const { setupPending, setupToken } = await ensureInstanceState()
  if (setupPending && setupToken) {
    // The only place the setup token ever appears in plaintext.
    console.log(`\n=== Chapters one-time setup token: ${setupToken} ===\n`)
  }
  await app.listen({ port: config.port, host: '0.0.0.0' })
  // One process, one port: the relay rides Fastify's own HTTP server.
  const collab = startCollabServer(app.server)
  // Hocuspocus used to install these itself inside its `listen()`. Without
  // them a redeploy drops every note edit still inside the store debounce.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void collab
        .destroy()
        .then(() => app.close())
        .finally(() => process.exit(0))
    })
  }
  startPollingScheduler(config.pollIntervalMs, config.webhookStaleThresholdMs)
  // Watchers live in process memory: without this pass every local_path
  // repository connected before the last restart silently stops ingesting.
  const watching = await startLocalWatchers()
  if (watching > 0) console.log(`watching ${watching} local repository folder(s)`)
  console.log(`Chapters server listening on :${config.port} (collab on ${COLLAB_PATH})`)
} catch (err) {
  console.error(err)
  process.exit(1)
}
