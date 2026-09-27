import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { buildInstanceBackup } from './archive.js'
import { deleteS3Object, listS3Objects, uploadS3Object, type S3Config } from './s3.js'

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
      .filter((name) => /^chapters-backup-.*\.zip$/.test(name))
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
 * Runs an instance backup and distributes it to all configured destinations
 * (local filesystem and/or S3-compatible object storage), applying retention pruning.
 */
export async function executeBackup(options?: { actorUserId?: string }): Promise<BackupRunResult> {
  const { destinations, s3Config, localPath } = getResolvedDestinations()
  if (destinations.length === 0) {
    throw new Error('No backup destinations configured. Set BACKUP_LOCAL_PATH or BACKUP_S3_BUCKET.')
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `chapters-backup-${timestamp}.zip`
  const zip = await buildInstanceBackup()
  const sizeBytes = zip.byteLength
  let totalPruned = 0

  try {
    if (localPath && destinations.includes('local')) {
      await mkdir(localPath, { recursive: true })
      await writeFile(join(localPath, filename), zip)
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
      executeBackup().catch((err) => {
        console.error('[backup-scheduler] automated backup failed:', err)
      })
    }
  }, checkIntervalMs)

  return () => clearInterval(timer)
}
