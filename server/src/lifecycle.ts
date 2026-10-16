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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  lastShutdown: ShutdownKind
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

/** Write-then-rename, so a kill mid-write leaves the old marker, never half a file. */
export function writeLifecycleMarker(dir: string, marker: LifecycleMarker): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, LIFECYCLE_FILE)
  writeFileSync(`${file}.tmp`, JSON.stringify(marker))
  renameSync(`${file}.tmp`, file)
}

/**
 * Called once, first thing at boot: reads how the previous process ended
 * into `bootInfo().lastShutdown`, then marks this one `running`. A data
 * directory that cannot be written leaves the next boot's verdict to
 * whatever marker is already there, so it is logged.
 */
export function recordBoot(dir: string = config.dataDir): {
  boot: Readonly<BootInfo>
  previous: LifecycleMarker | null
} {
  const { lastShutdown, previous } = readPreviousShutdown(dir)
  boot.lastShutdown = lastShutdown
  try {
    writeLifecycleMarker(dir, {
      state: 'running',
      bootId: boot.bootId,
      startedAt: boot.startedAt,
      version: boot.version,
    })
  } catch (err) {
    console.warn(`could not write ${LIFECYCLE_FILE} in ${dir}: ${String(err)}`)
  }
  return { boot, previous }
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
export function bootLogLine(boot: Readonly<BootInfo>, previous: LifecycleMarker | null): string {
  return JSON.stringify({
    event: 'boot',
    bootId: boot.bootId,
    startedAt: boot.startedAt,
    version: boot.version,
    lastShutdown: boot.lastShutdown,
    previous: previous
      ? {
          bootId: previous.bootId,
          startedAt: previous.startedAt,
          version: previous.version,
          stoppedAt: previous.stoppedAt ?? null,
          signal: previous.signal ?? null,
        }
      : null,
  })
}
