/**
 * The instance maintenance lock (ADR-003 §5.1 rev 5, §9): a session-level
 * Postgres advisory lock on INSTANCE_LOCK_KEY, held on a connection reserved
 * for the process lifetime (its own single-connection client, exempt from the
 * pool's idle and lifetime recycling; a session lock lives and dies with its
 * connection).
 *
 * - Every server, and every writing CLI (`restore-backup`, `reindex`), holds
 *   the **shared** form from before migrations until exit.
 * - `store-export-legacy` holds the **exclusive** form, so it refuses to run
 *   while any server or writing CLI is up, and a server started during the
 *   export refuses to start ("maintenance in progress").
 *
 * If the shared lock's connection drops, writes pause at once:
 * `storeTransaction` answers StoreBusyError (`status: retry`, HTTP 503) and
 * the relay refuses collab updates (unacked, so clients resend), exactly as
 * while Postgres is down. The holder then retries `pg_try_advisory_lock_shared`
 * on a new connection with backoff while Postgres is unreachable, and resumes
 * writes once it holds the shared lock again. It exits only when that call
 * returns false: an exporter holds the exclusive form and this process must
 * not write. Store transactions also take the shared form transaction-scoped
 * (store-tx.ts), which closes the gap between a drop and the pause.
 */
import postgres from 'postgres'
import { config } from '../config.js'

/**
 * The advisory lock key of the instance maintenance lock (§5.1, §9). Every
 * store transaction also takes its shared form, transaction-scoped.
 */
export const INSTANCE_LOCK_KEY = 0x454c_4152_4100n

export type InstanceLockMode = 'shared' | 'exclusive'

/** The lock is held in the other form by another process: a server or CLI (for the exclusive form) or an exporter (shared). */
export class MaintenanceInProgressError extends Error {
  constructor(mode: InstanceLockMode) {
    super(
      mode === 'shared'
        ? 'maintenance in progress: store-export-legacy holds the instance lock; start the server after it finishes'
        : 'the instance is in use: a server or a writing CLI holds the instance lock; stop it first',
    )
  }
}

export interface InstanceLockOptions {
  /** Shared form only: the lock was lost and an exporter holds it now. Default: log and exit(1). */
  onExclusiveHeld?: () => void
  /** Exclusive form only: the connection dropped, so the lock is gone. Default: log and exit(1). */
  onLost?: () => void
  /** First re-acquire delay; doubles up to `maxBackoffMs`. */
  backoffMs?: number
  maxBackoffMs?: number
  /** How often the reserved connection is probed (a half-open socket closes no connection). */
  heartbeatMs?: number
  /** Tests only: the database the reserved connection uses (default `config.databaseUrl`), e.g. through a proxy that can cut it. */
  databaseUrl?: string
}

export interface InstanceLock {
  readonly mode: InstanceLockMode
  /** Unlocks and closes the reserved connection; no re-acquire after it. */
  release(): Promise<void>
}

let paused = false
let exclusiveOwner = false

/** True while this process has lost its shared lock and has not taken it again: every store write answers "retry". */
export function writesPaused(): boolean {
  return paused
}

/** True while this process holds the exclusive form (the exporter): its own store transactions skip the shared check. */
export function holdsExclusiveLock(): boolean {
  return exclusiveOwner
}

type Client = postgres.Sql

function reservedClient(databaseUrl: string, onclose: () => void): Client {
  return postgres(databaseUrl, {
    max: 1,
    idle_timeout: null as unknown as undefined,
    max_lifetime: null,
    connect_timeout: 10,
    fetch_types: false,
    onnotice: () => {},
    onclose,
  })
}

async function tryLock(client: Client, mode: InstanceLockMode): Promise<boolean> {
  const fn = mode === 'shared' ? 'pg_try_advisory_lock_shared' : 'pg_try_advisory_lock'
  const [row] = await client.unsafe<Array<{ ok: boolean }>>(`SELECT ${fn}(${INSTANCE_LOCK_KEY}) AS ok`)
  return Boolean(row?.ok)
}

/**
 * Takes the instance lock in `mode` on a reserved connection. Throws
 * MaintenanceInProgressError when the other form is held (nothing is kept
 * open then). Connection errors propagate: Postgres must be reachable at start.
 */
export async function holdInstanceLock(mode: InstanceLockMode, options: InstanceLockOptions = {}): Promise<InstanceLock> {
  const backoffMs = options.backoffMs ?? 250
  const maxBackoffMs = options.maxBackoffMs ?? 10_000
  const heartbeatMs = options.heartbeatMs ?? 5_000
  let released = false
  let epoch = 0
  let client: Client | null = null
  let heartbeat: NodeJS.Timeout | undefined

  const stopHeartbeat = () => {
    clearInterval(heartbeat)
    heartbeat = undefined
  }

  /**
   * Opens a reserved connection and tries the lock; returns the client when
   * held. Only a connection that held the lock reports a drop: postgres.js
   * also calls `onclose` when a connection attempt fails, and counting that
   * as a drop would start a second re-acquire loop for every failed attempt.
   */
  async function acquire(): Promise<Client | null> {
    const mine = ++epoch
    let held = false
    const next = reservedClient(options.databaseUrl ?? config.databaseUrl, () => {
      if (held) dropped(mine)
    })
    try {
      held = await tryLock(next, mode)
    } catch (err) {
      await next.end({ timeout: 0 }).catch(() => {})
      throw err
    }
    if (held) return next
    await next.end({ timeout: 0 }).catch(() => {})
    return null
  }

  function startHeartbeat(current: Client, mine: number): void {
    stopHeartbeat()
    heartbeat = setInterval(() => {
      current`SELECT 1`.catch(() => dropped(mine))
    }, heartbeatMs)
    heartbeat.unref()
  }

  function dropped(mine: number): void {
    if (released || mine !== epoch) return
    epoch++ // later events of the lost connection are ignored
    stopHeartbeat()
    const lost = client
    client = null
    void lost?.end({ timeout: 0 }).catch(() => {})
    if (mode === 'exclusive') {
      exclusiveOwner = false
      console.error('[maintenance] the exclusive instance lock was lost (connection dropped)')
      ;(options.onLost ?? (() => process.exit(1)))()
      return
    }
    paused = true
    console.error('[maintenance] instance lock connection dropped: writes paused until the lock is held again')
    void reacquire()
  }

  async function reacquire(): Promise<void> {
    let delay = backoffMs
    while (!released) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
      if (released) return
      try {
        const next = await acquire()
        if (!next) {
          console.error('[maintenance] store-export-legacy holds the instance lock: exiting (writes stay paused)')
          ;(options.onExclusiveHeld ?? (() => process.exit(1)))()
          return
        }
        if (released) {
          await next.end({ timeout: 0 }).catch(() => {})
          return
        }
        client = next
        startHeartbeat(next, epoch)
        paused = false
        console.log('[maintenance] instance lock held again: writes resumed')
        return
      } catch (err) {
        console.error(`[maintenance] re-acquiring the instance lock failed, retrying in ${delay} ms:`, err instanceof Error ? err.message : err)
        delay = Math.min(delay * 2, maxBackoffMs)
      }
    }
  }

  client = await acquire()
  if (!client) throw new MaintenanceInProgressError(mode)
  startHeartbeat(client, epoch)
  if (mode === 'exclusive') exclusiveOwner = true

  return {
    mode,
    async release() {
      released = true
      epoch++
      stopHeartbeat()
      if (mode === 'exclusive') exclusiveOwner = false
      else paused = false
      const current = client
      client = null
      if (!current) return
      const unlock = mode === 'shared' ? 'pg_advisory_unlock_shared' : 'pg_advisory_unlock'
      await current.unsafe(`SELECT ${unlock}(${INSTANCE_LOCK_KEY})`).catch(() => {})
      await current.end({ timeout: 5 }).catch(() => {})
    },
  }
}

/**
 * The start of every server and writing CLI (before migrations): the shared
 * form, or exit 2 with "maintenance in progress" while an exporter runs.
 */
export async function holdSharedLockOrExit(): Promise<InstanceLock> {
  try {
    return await holdInstanceLock('shared')
  } catch (err) {
    if (!(err instanceof MaintenanceInProgressError)) throw err
    console.error(err.message)
    process.exit(2)
  }
}
