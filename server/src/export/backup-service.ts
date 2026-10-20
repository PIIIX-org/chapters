import { chmod, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { buildInstanceBackup } from './archive.js'
import { deleteS3Object, listS3Objects, uploadS3Object, type S3Config } from './s3.js'
import { errorInfo, recordJob } from '../monitoring/metrics.js'
import { atomicWrite } from '../notes/atomic-write.js'

/**
 * A backup holds password and token hashes, TOTP secrets and every note:
 * readable by the server's user only, whatever the umask (#409, #493).
 */
const BACKUP_FILE_MODE = 0o600
const BACKUP_DIR_MODE = 0o700
const BACKUP_NAME = /^(?:elara|chapters)-backup-.*\.zip$/

/**
 * Creates the backup directory 0700 and tightens it if it already existed,
 * along with the backups already in it (written 0644 before #493).
 * Something the server does not own (a mount) can't be chmodded: that is a
 * warning, not a failed backup; the new file is 0600 either way.
 */
async function preparePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: BACKUP_DIR_MODE })
  const tighten = async (path: string, mode: number) => {
    try {
      await chmod(path, mode)
    } catch (err) {
      console.warn(`[backup] could not make ${path} private (mode ${mode.toString(8)}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  await tighten(dir, BACKUP_DIR_MODE)
  for (const name of await readdir(dir)) {
    if (BACKUP_NAME.test(name)) await tighten(join(dir, name), BACKUP_FILE_MODE)
  }
}

export type BackupDestination = 'local' | 's3'

export interface BackupStatus {
  configured: boolean
  destinations: BackupDestination[]
  localPath?: string
  s3Bucket?: string
  s3Prefix?: string
  retentionCount: number
  intervalHours: number
  lastRunAt: string | null
  lastStatus: 'idle' | 'success' | 'error'
  lastError: string | null
  lastFilename: string | null
  lastSizeBytes: number | null
}

export interface BackupRunResult {
  filename: string
  sizeBytes: number
  destinations: BackupDestination[]
  prunedCount: number
  completedAt: string
}

let lastRunAt: string | null = null
let lastStatus: 'idle' | 'success' | 'error' = 'idle'
let lastError: string | null = null
let lastFilename: string | null = null
let lastSizeBytes: number | null = null
/**
 * The last backup, scheduled or on demand, failed (#705). A scheduled backup
 * that fails while this is set is a repeat for the monitoring metrics, not a
 * new failure; any success clears it, so a backup that breaks again after an
 * operator fixed and checked it alerts again. Process-local.
 */
let backupFailing = false

export function getResolvedDestinations(): {
  destinations: BackupDestination[]
  s3Config?: S3Config
  localPath?: string
} {
  const destinations: BackupDestination[] = []
  let s3Config: S3Config | undefined

  if (config.backup.localPath) {
    destinations.push('local')
  }

  if (
    config.backup.s3Bucket &&
    config.backup.s3AccessKeyId &&
    config.backup.s3SecretAccessKey
  ) {
    destinations.push('s3')
    s3Config = {
      endpoint: config.backup.s3Endpoint,
      region: config.backup.s3Region,
      bucket: config.backup.s3Bucket,
      accessKeyId: config.backup.s3AccessKeyId,
      secretAccessKey: config.backup.s3SecretAccessKey,
      forcePathStyle: config.backup.s3ForcePathStyle,
    }
  }

  return {
    destinations,
    s3Config,
    localPath: config.backup.localPath,
  }
}

/** Prunes local backup snapshots exceeding retention count (newest preserved). */
export async function pruneLocalBackups(dir: string, retentionCount: number): Promise<number> {
  try {
    const entries = await readdir(dir)
    const backupFiles = entries
      .filter((name) => BACKUP_NAME.test(name))
      .sort()
      .reverse()

    const toDelete = backupFiles.slice(retentionCount)
    for (const filename of toDelete) {
      await unlink(join(dir, filename))
    }
    return toDelete.length
  } catch {
    return 0
  }
}

/** Prunes S3 backup snapshots exceeding retention count (newest preserved). */
export async function pruneS3Backups(
  s3Config: S3Config,
  prefix: string,
  retentionCount: number,
): Promise<number> {
  try {
    const objects = await listS3Objects(s3Config, prefix)
    const backupKeys = objects
      .map((o) => o.key)
      .filter((k) => k.endsWith('.zip'))
      .sort()
      .reverse()

    const toDelete = backupKeys.slice(retentionCount)
    for (const key of toDelete) {
      await deleteS3Object(s3Config, key)
    }
    return toDelete.length
  } catch {
    return 0
  }
}

/**
 * Building the archive failed (database dump, a vault file). The message is
 * fixed because the original one can name a note's path or a database value,
 * and this one is shown on the admin page (`lastError`) and in the run
 * endpoint's 500 (#771). The `code` (EACCES, a Postgres SQLSTATE) is kept for
 * the operator and the monitoring report; the original error is the `cause`,
 * printed in the server log only.
 */
class BackupBuildError extends Error {
  readonly code: string | null
  constructor(cause: unknown) {
    const { code } = errorInfo(cause)
    super(`Building the backup archive failed${code ? ` (${code})` : ''}; details in the server log`, { cause })
    this.name = 'BackupBuildError'
    this.code = code
  }
}

/**
 * Runs an instance backup and distributes it to all configured destinations
 * (local filesystem and/or S3-compatible object storage), applying retention pruning.
 */
export async function executeBackup(options?: { actorUserId?: string }): Promise<BackupRunResult> {
  const { destinations, s3Config, localPath } = getResolvedDestinations()
  if (destinations.length === 0) {
    throw new Error('No backup destinations configured. Set BACKUP_LOCAL_PATH or BACKUP_S3_BUCKET.')
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `elara-backup-${timestamp}.zip`
  let totalPruned = 0

  try {
    // Inside the try: a failed build is a failed run too, so the scheduler
    // waits a full interval instead of rebuilding every 15 minutes (#771).
    const zip = await buildInstanceBackup().catch((err: unknown) => {
      throw new BackupBuildError(err)
    })
    const sizeBytes = zip.byteLength

    if (localPath && destinations.includes('local')) {
      await preparePrivateDir(localPath)
      // Atomic: a crash mid-write leaves a temp file, never a truncated zip under
      // a backup name. The temp file is 0600 before the content goes in.
      await atomicWrite(join(localPath, filename), zip, { mode: BACKUP_FILE_MODE })
      const pruned = await pruneLocalBackups(localPath, config.backup.retentionCount)
      totalPruned += pruned
    }

    if (s3Config && destinations.includes('s3')) {
      const cleanPrefix = config.backup.s3Prefix.replace(/^\//, '')
      const s3Key = `${cleanPrefix}${filename}`
      await uploadS3Object(s3Config, s3Key, zip, 'application/zip')
      const pruned = await pruneS3Backups(s3Config, cleanPrefix, config.backup.retentionCount)
      totalPruned += pruned
    }

    lastRunAt = new Date().toISOString()
    lastStatus = 'success'
    lastError = null
    lastFilename = filename
    lastSizeBytes = sizeBytes
    backupFailing = false

    await logSecurityEvent({
      type: 'instance_backup_created',
      actorUserId: options?.actorUserId,
      detail: {
        filename,
        sizeBytes,
        destinations,
        prunedCount: totalPruned,
      },
    })

    return {
      filename,
      sizeBytes,
      destinations,
      prunedCount: totalPruned,
      completedAt: lastRunAt,
    }
  } catch (err) {
    lastRunAt = new Date().toISOString()
    lastStatus = 'error'
    lastError = err instanceof Error ? err.message : String(err)
    backupFailing = true
    throw err
  }
}

export function getBackupStatus(): BackupStatus {
  const { destinations, localPath, s3Config } = getResolvedDestinations()
  return {
    configured: destinations.length > 0,
    destinations,
    localPath,
    s3Bucket: s3Config?.bucket,
    s3Prefix: s3Config ? config.backup.s3Prefix : undefined,
    retentionCount: config.backup.retentionCount,
    intervalHours: config.backup.intervalHours,
    lastRunAt,
    lastStatus,
    lastError,
    lastFilename,
    lastSizeBytes,
  }
}

/**
 * Starts background scheduler interval for automated backups.
 * Executes on schedule if destinations are configured and intervalHours > 0.
 */
export function startBackupScheduler(): () => void {
  const { destinations } = getResolvedDestinations()
  if (destinations.length === 0 || config.backup.intervalHours <= 0) {
    return () => {}
  }

  // Check every 15 minutes if a backup is due
  const checkIntervalMs = 15 * 60 * 1000
  const intervalMs = config.backup.intervalHours * 60 * 60 * 1000

  const timer = setInterval(() => {
    const now = Date.now()
    const lastRunTime = lastRunAt ? new Date(lastRunAt).getTime() : 0
    if (now - lastRunTime >= intervalMs) {
      // Scheduled runs only: an on-demand backup that fails is a 5xx, which
      // is reported as a server error already (#705). A failure after a
      // failed backup is a repeat (`backupFailing`): with intervalHours = 1 a
      // broken destination would otherwise be a new alert every hour.
      const wasFailing = backupFailing
      executeBackup().then(
        () => recordJob('backup', 'ok'),
        (err) => {
          console.error('[backup-scheduler] automated backup failed:', err)
          recordJob('backup', { error: err, repeat: wasFailing })
        },
      )
    }
  }, checkIntervalMs)

  return () => clearInterval(timer)
}
