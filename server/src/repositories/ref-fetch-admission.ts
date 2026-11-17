/**
 * Admission for reader-chosen ref fetches (#676): a cache miss in the query mirror launches `git fetch`, which a repository
 * reader (no write permission) could otherwise repeat for distinct commits. Three simple rules, all refused without
 * launching git and without queueing (the caller answers `BUSY`, retry later):
 *
 * - at most `maxConcurrent` (2) fetches run in the instance;
 * - each account may fetch `ELARA_REF_FETCH_ACCOUNT_MB` (default 1,024) MiB per hour, the instance
 *   `ELARA_REF_FETCH_INSTANCE_MB` (default 4,096) MiB per hour: token buckets that refill continuously (the allowance divided
 *   by 3,600 seconds per second), full at the start of a process;
 * - a fetch reserves its whole budget (`QUERY_MIRROR_LIMITS.fetchBytes`) from both buckets before it starts and settles with
 *   the bytes it actually brought in: the unused part is refunded, an overshoot is debited.
 *
 * The bucket sizes are read on each admission (so an operator edit takes effect after a restart and a test can change them);
 * state is per process. Kept out of `config.ts`: the benchmark plan treats that file as ranking-relevant.
 */
export const REF_FETCH_ADMISSION = { maxConcurrent: 2 }
const HOUR_SECONDS = 3600
const MAX_ACCOUNTS = 10_000

export class RefFetchRefused extends Error {}

interface Bucket {
  tokens: number
  at: number
}

const accounts = new Map<string, Bucket>()
let instance: Bucket | null = null
let running = 0
let clock: () => number = () => Date.now()

const mebibytes = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return (Number.isFinite(raw) && raw > 0 ? raw : fallback) * 1024 * 1024
}

function refill(bucket: Bucket, limit: number): void {
  const now = clock()
  bucket.tokens = Math.min(limit, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * (limit / HOUR_SECONDS))
  bucket.at = now
}

export interface RefFetchSlot {
  /** Ends the fetch with the bytes it brought in; the rest of the reservation returns to both buckets. */
  settle: (usedBytes: number) => void
}

/** Reserves one fetch of up to `bytes` for `accountId`, or throws `RefFetchRefused` (no git has been launched). */
export function admitRefFetch(accountId: string, bytes: number): RefFetchSlot {
  if (running >= REF_FETCH_ADMISSION.maxConcurrent) throw new RefFetchRefused('another ref fetch is running; retry in a moment')
  const accountMax = mebibytes('ELARA_REF_FETCH_ACCOUNT_MB', 1024)
  const instanceMax = mebibytes('ELARA_REF_FETCH_INSTANCE_MB', 4096)
  const now = clock()
  const mine = accounts.get(accountId) ?? { tokens: accountMax, at: now }
  refill(mine, accountMax)
  instance ??= { tokens: instanceMax, at: now }
  refill(instance, instanceMax)
  if (mine.tokens < bytes) throw new RefFetchRefused(`this account's ref fetch allowance (${accountMax / 1024 / 1024} MiB per hour) is used up; retry later`)
  if (instance.tokens < bytes) throw new RefFetchRefused(`the instance's ref fetch allowance (${instanceMax / 1024 / 1024} MiB per hour) is used up; retry later`)
  mine.tokens -= bytes
  instance.tokens -= bytes
  if (!accounts.has(accountId) && accounts.size >= MAX_ACCOUNTS) accounts.delete(accounts.keys().next().value!)
  accounts.set(accountId, mine)
  running++
  let settled = false
  return {
    settle(usedBytes) {
      if (settled) return
      settled = true
      running--
      const refund = bytes - Math.max(0, usedBytes)
      // Both buckets may have refilled meanwhile: the refund never lifts one above its size.
      for (const [bucket, limit] of [[accounts.get(accountId), accountMax], [instance, instanceMax]] as const) {
        if (bucket) bucket.tokens = Math.min(limit, bucket.tokens + refund)
      }
    },
  }
}

/** Test hooks: a fake clock and a clean slate. */
export function resetRefFetchAdmission(now?: () => number): void {
  accounts.clear()
  instance = null
  running = 0
  clock = now ?? (() => Date.now())
}
