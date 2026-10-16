// Process lifecycle (#583): which process is answering, and how the one
// before it ended. Production once restarted (likely OOM) and nobody
// noticed; everything queued in memory was lost. `/health` exposes this so
// an outside monitor can see a restart without access to the host.
//
// The previous shutdown is read from a marker file in DATA_DIR (the volume
// that outlives the container): written `running` at boot and `stopped`
// after a clean SIGTERM/SIGINT shutdown. A boot that finds `running` knows
// the previous process never reached the end of its shutdown: SIGKILL, OOM
// kill, crash, uncaught exception, or a shutdown Docker cut short.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

export type ShutdownKind = 'graceful' | 'unclean' | 'unknown'

export const LIFECYCLE_FILE = 'lifecycle.json'

export interface LifecycleMarker {
  state: 'running' | 'stopped'
  bootId: string
  startedAt: string
  version: string | null
  /** Set with `state: 'stopped'`. */
  stoppedAt?: string
  signal?: string
}

export interface BootInfo {
  /** Process start time, ISO 8601. */
  startedAt: string
  /** UUIDv7 for this process: random, and ordered by start time. */
  bootId: string
  /** Commit the image was built from (`ELARA_VERSION`), or null. */
  version: string | null
  /** How the process before this one ended. */
  lastShutdown: ShutdownKind
  /**
   * `bootId` of the process `lastShutdown` describes, or null when unknown.
   * A monitor that last saw a different bootId missed a restart in between.
   */
  previousBootId: string | null
}

export interface BootRecord {
  boot: Readonly<BootInfo>
  /** The marker read at boot, as found (also when it was not trusted). */
  previous: LifecycleMarker | null
  /** Why this boot could not write its `running` marker, or null. */
  markerError: string | null
}

/**
 * RFC 9562 UUIDv7: 48-bit Unix milliseconds, then random bits. Two boots
 * never share an id, and a later boot sorts after an earlier one as long as
 * the host clock moves forward.
 */
export function uuidv7(ms: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  const b = new Uint8Array(16)
  let t = Math.floor(ms)
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256
    t = Math.floor(t / 256)
  }
  b[6] = 0x70 | (random[0]! & 0x0f)
  b[7] = random[1]!
  b[8] = 0x80 | (random[2]! & 0x3f)
  b.set(random.subarray(3, 10), 9)
  const hex = Buffer.from(b).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// performance.timeOrigin is when this process started, not when this
// module loaded.
const boot: BootInfo = {
  startedAt: new Date(performance.timeOrigin).toISOString(),
  bootId: uuidv7(performance.timeOrigin),
  version: config.version,
  lastShutdown: 'unknown',
  previousBootId: null,
}

/** This process's identity, as `/health` reports it. */
export function bootInfo(): Readonly<BootInfo> {
  return boot
}

/**
 * How the process that last used `dir` ended: `stopped` marker = graceful,
 * `running` marker = unclean, no marker or an unreadable one = unknown
 * (first boot on this data directory, or a marker this code did not write).
 */
export function readPreviousShutdown(dir: string): {
  lastShutdown: ShutdownKind
  previous: LifecycleMarker | null
} {
  let raw: string
  try {
    raw = readFileSync(join(dir, LIFECYCLE_FILE), 'utf8')
  } catch {
    return { lastShutdown: 'unknown', previous: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { lastShutdown: 'unknown', previous: null }
  }
  const marker = parsed as Partial<LifecycleMarker> | null
  if (marker?.state === 'stopped') return { lastShutdown: 'graceful', previous: marker as LifecycleMarker }
  if (marker?.state === 'running') return { lastShutdown: 'unclean', previous: marker as LifecycleMarker }
  return { lastShutdown: 'unknown', previous: null }
}

/**
 * Write-then-rename, so a kill mid-write leaves the old marker, never half a
 * file. The temp name is per process; the marker itself assumes one process
 * per DATA_DIR (a second one would overwrite it).
 */
export function writeLifecycleMarker(dir: string, marker: LifecycleMarker): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, LIFECYCLE_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(marker))
    renameSync(tmp, file)
  } catch (err) {
    // Best effort: do not leave a partial temp file behind (it is not the marker).
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* the write error is the one that matters */
    }
    throw err
  }
}

/**
 * Called once, first thing at boot: reads how the previous process ended
 * into `bootInfo()`, then marks this one `running`.
 *
 * If that write fails (full or read-only volume), the marker on disk is not
 * this process's, so it cannot say how this process ends: a crash would be
 * read as whatever an older process left, `stopped` included. So the marker
 * is deleted (unlink works on a full disk), which makes the next boot say
 * `unknown`; and this boot reports `unknown` too, because the previous
 * process may have failed the same way, leaving the marker just read stale.
 */
export function recordBoot(dir: string = config.dataDir): BootRecord {
  const { lastShutdown, previous } = readPreviousShutdown(dir)
  boot.lastShutdown = lastShutdown
  boot.previousBootId = typeof previous?.bootId === 'string' ? previous.bootId : null
  let markerError: string | null = null
  try {
    writeLifecycleMarker(dir, {
      state: 'running',
      bootId: boot.bootId,
      startedAt: boot.startedAt,
      version: boot.version,
    })
  } catch (err) {
    markerError = String(err)
    boot.lastShutdown = 'unknown'
    boot.previousBootId = null
    try {
      rmSync(join(dir, LIFECYCLE_FILE), { force: true })
    } catch (rmErr) {
      markerError += `; could not remove the old marker either: ${String(rmErr)}`
    }
    console.warn(`could not write ${LIFECYCLE_FILE} in ${dir}, lastShutdown is unknown: ${markerError}`)
  }
  return { boot, previous, markerError }
}

/** Called at the very end of a clean signal shutdown, after every flush. */
export function recordGracefulShutdown(signal: string, dir: string = config.dataDir): void {
  try {
    writeLifecycleMarker(dir, {
      state: 'stopped',
      bootId: boot.bootId,
      startedAt: boot.startedAt,
      version: boot.version,
      stoppedAt: new Date().toISOString(),
      signal,
    })
  } catch (err) {
    console.warn(`could not write ${LIFECYCLE_FILE} in ${dir}: ${String(err)}`)
  }
}

/** The single structured boot log line. */
export function bootLogLine({ boot, previous, markerError }: BootRecord): string {
  return JSON.stringify({
    event: 'boot',
    bootId: boot.bootId,
    startedAt: boot.startedAt,
    version: boot.version,
    lastShutdown: boot.lastShutdown,
    previousBootId: boot.previousBootId,
    previous: previous
      ? {
          bootId: previous.bootId,
          startedAt: previous.startedAt,
          version: previous.version,
          stoppedAt: previous.stoppedAt ?? null,
          signal: previous.signal ?? null,
        }
      : null,
    markerError,
  })
}
