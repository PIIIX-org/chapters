import { buildApp } from './app.js'
import { startCollabServer } from './sync/collab-server.js'
import { runMigrations } from './db/migrate.js'
import { ensureInstanceState } from './auth/bootstrap.js'
import { scheduleMissingEmbeddings } from './search/embedding-queue.js'
import { startLocalWatchers, startPollingScheduler } from './repositories/scheduler.js'
import { config } from './config.js'

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
  await startCollabServer(config.collabPort)
  startPollingScheduler(config.pollIntervalMs, config.webhookStaleThresholdMs)
  // Watchers live in process memory: without this pass every local_path
  // repository connected before the last restart silently stops ingesting.
  const watching = await startLocalWatchers()
  if (watching > 0) console.log(`watching ${watching} local repository folder(s)`)
  console.log(`Chapters server listening on :${config.port} (collab on :${config.collabPort})`)
} catch (err) {
  console.error(err)
  process.exit(1)
}
