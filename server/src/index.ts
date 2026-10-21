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
import { bootStore } from './notes/store-reconcile.js'
import { flushProjections, sweepOrphanFiles } from './notes/projector.js'
import { holdSharedLockOrExit } from './notes/maintenance-lock.js'
import { COLLAB_PATH } from './sync/routes.js'
import { bootLogLine, recordBoot, recordGracefulShutdown } from './lifecycle.js'

// ADR-003 §5.1/§9: the shared instance lock on a reserved connection, held
// from before migrations until exit. Refused (exit 2) while
// store-export-legacy runs; a dropped connection pauses writes until it is
// held again (maintenance-lock.ts). Taken before the boot is recorded: a
// start refused here wrote nothing, so the marker keeps saying how the last
// server that ran ended (a refused start is not an unclean shutdown).
await holdSharedLockOrExit()

// Before anything else that can fail: a boot that dies in migrations still
// marks this process `running`, so the next boot reports it as unclean
// (#583). So does a SIGTERM that arrives before the handlers below are
// installed (during migrations and catch-ups): Node's default exit writes nothing.
const bootRecord = recordBoot()
console.log(bootLogLine(bootRecord))
if (process.env.ELARA_MONITORING_TOKEN && !config.monitoringToken) {
  console.warn(`ELARA_MONITORING_TOKEN is shorter than ${MIN_MONITORING_TOKEN_LENGTH} characters and is ignored: /api/admin/monitoring needs an admin session`)
}

const app = await buildApp()

try {
  await runMigrations()
  // ADR-003 S2a, before anything is served (§7 boot steps 2-8): stale
  // projection claims cleared, the one-time backfill (resumable), the
  // reconciliation of rows written around the store, after an unclean or
  // unknown shutdown a verify of every file against its row, and the
  // projector run until files equal rows. Nothing here aborts boot because
  // of one note.
  const store = await bootStore({ lastShutdown: bootRecord.boot.lastShutdown })
  if (!store.migrated) console.warn('store backfill had failures: see the migration report; it runs again at the next boot')
  const r = store.reconciled
  if (r && r.projections + r.raised + r.revisions + r.failed > 0) console.log(`store reconciliation: ${JSON.stringify(r)}`)
  if (store.verified > 0) console.log(`verified ${store.verified} projection(s) after a ${bootRecord.boot.lastShutdown} shutdown`)
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
  // Boot step 9, in the background (bootStore already drained the
  // projector): `.md` files no row or projection owns are moved to
  // `.orphans/`, never deleted. Each path is decided under its path lock.
  void sweepOrphanFiles()
    .then((moved) => {
      if (moved.length > 0) console.warn(`moved ${moved.length} orphan note file(s) to .orphans/`)
    })
    .catch((err: unknown) => console.error('orphan sweep failed:', err))
  // Hocuspocus used to install these itself inside its `listen()`. Without
  // them a redeploy drops every note edit still inside the store debounce.
  // After the relay's last stores commit, the projector gets a bounded drain
  // (ADR-003 §7) so their files land and no claim is left behind.
  const drainProjector = () =>
    Promise.race([flushProjections(), new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref())]).catch(() => {})
  const shutdown = () => collab.destroy().then(drainProjector).then(() => app.close())
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown()
        .then(() => sql.end({ timeout: 5 }))
        // Only once every flush finished: a shutdown that fails or that
        // Docker cuts short with SIGKILL stays `unclean`.
        .then(() => recordGracefulShutdown(signal))
        .finally(() => process.exit(0))
    })
  }
  process.on('uncaughtException', (err) => {
    app.log.error(err, 'uncaught exception, initiating shutdown')
    void shutdown()
      .then(() => sql.end({ timeout: 5 }))
      .finally(() => process.exit(1))
  })
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled rejection, initiating shutdown')
    void shutdown()
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
