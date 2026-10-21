import { buildApp } from './app.js'
import { startCollabServer } from './sync/collab-server.js'
import { runMigrations } from './db/migrate.js'
import { ensureInstanceState } from './auth/bootstrap.js'
import { EMBEDDING_JOB, scheduleMissingEmbeddings } from './search/embedding-queue.js'
import { startLocalWatchers, startPollingScheduler, reconcileOrphanedSyncs } from './repositories/scheduler.js'
import { EXTRACTION_JOB, backfillUnresolvedImports, scheduleMissingExtractions } from './repositories/extraction-queue.js'
import { pruneFinishedJobs, startJobPolling } from './jobs/durable.js'
import { scrubStoredGitCredentials } from './repositories/git-remote.js'
import { startBackupScheduler } from './export/backup-service.js'
import { config, MIN_MONITORING_TOKEN_LENGTH } from './config.js'
import { sql } from './db/client.js'
import { COLLAB_PATH } from './sync/routes.js'
import { bootLogLine, recordBoot, recordGracefulShutdown } from './lifecycle.js'

// Before anything that can fail: a boot that dies in migrations still marks
// this process `running`, so the next boot reports it as unclean (#583). So
// does a SIGTERM that arrives before the handlers below are installed
// (during migrations and catch-ups): Node's default exit writes nothing.
console.log(bootLogLine(recordBoot()))
if (process.env.ELARA_MONITORING_TOKEN && !config.monitoringToken) {
  console.warn(`ELARA_MONITORING_TOKEN is shorter than ${MIN_MONITORING_TOKEN_LENGTH} characters and is ignored: /api/admin/monitoring needs an admin session`)
}

const app = await buildApp()

try {
  await runMigrations()
  // Before anything serves or syncs a repository: remotes stored with a
  // credential in the URL (before #383 was fixed) are moved to encrypted storage.
  const scrub = await scrubStoredGitCredentials()
  if (scrub.scrubbed > 0) console.log(`moved credentials out of ${scrub.scrubbed} repository git URL(s)`)
  if (scrub.skipped > 0) console.warn(`${scrub.skipped} repository git URL(s) still hold a credential: set CREDENTIALS_ENCRYPTION_KEY`)
  // Embedding and extraction jobs are rows in `jobs` (#494): the worker resumes
  // pending ones, reclaims those whose lease a dead process left and fails
  // those whose runs ended with the process 3 times (LeaseExpired). These
  // scans add jobs (idempotently) for rows without an embedding and no job
  // (written before the jobs table), and re-run jobs of the current content or
  // `seq` that failed with an error (an outage that outlasted the retries).
  const pruned = await pruneFinishedJobs([EMBEDDING_JOB, EXTRACTION_JOB])
  if (pruned > 0) console.log(`pruned ${pruned} finished background job(s)`)
  const missing = await scheduleMissingEmbeddings()
  if (missing > 0) console.log(`embedding catch-up: ${missing} notes without an embedding or with a failed job`)
  const missingFiles = await scheduleMissingExtractions()
  if (missingFiles > 0) console.log(`extraction catch-up: ${missingFiles} repository files without an embedding or with a failed job`)
  startJobPolling()
  const reconciled = await reconcileOrphanedSyncs()
  if (reconciled > 0) console.log(`reconciled ${reconciled} orphaned repository sync(s) to idle`)
  const backfilled = await backfillUnresolvedImports()
  if (backfilled > 0) console.log(`resolved ${backfilled} previously unresolved code import(s)`)
  const { setupPending, setupToken } = await ensureInstanceState()
  if (setupPending && setupToken) {
    // The only place the setup token ever appears in plaintext.
    console.log(`\n=== Elara one-time setup token: ${setupToken} ===\n`)
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
        .then(() => sql.end({ timeout: 5 }))
        // Only once every flush finished: a shutdown that fails or that
        // Docker cuts short with SIGKILL stays `unclean`.
        .then(() => recordGracefulShutdown(signal))
        .finally(() => process.exit(0))
    })
  }
  process.on('uncaughtException', (err) => {
    app.log.error(err, 'uncaught exception, initiating shutdown')
    void collab
      .destroy()
      .then(() => app.close())
      .then(() => sql.end({ timeout: 5 }))
      .finally(() => process.exit(1))
  })
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled rejection, initiating shutdown')
    void collab
      .destroy()
      .then(() => app.close())
      .then(() => sql.end({ timeout: 5 }))
      .finally(() => process.exit(1))
  })
  startPollingScheduler(config.pollIntervalMs, config.webhookStaleThresholdMs)
  startBackupScheduler()
  // Watchers live in process memory: without this pass every local_path
  // repository connected before the last restart silently stops ingesting.
  const watching = await startLocalWatchers()
  if (watching > 0) console.log(`watching ${watching} local repository folder(s)`)
  console.log(`Elara server listening on :${config.port} (collab on ${COLLAB_PATH})`)
} catch (err) {
  console.error(err)
  process.exit(1)
}
