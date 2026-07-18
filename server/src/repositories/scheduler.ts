import { and, eq, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { syncGitRepository } from './git-sync.js'

/**
 * Pure decision function (unit-tested directly — the interval loop
 * around it isn't): poll unless a webhook has been seen recently
 * enough that the repository is already staying current on its own.
 */
export function shouldPoll(
  lastWebhookAt: Date | null,
  lastSyncedAt: Date | null,
  now: Date,
  thresholdMs: number,
): boolean {
  if (!lastWebhookAt) return true
  const webhookIsStale = now.getTime() - lastWebhookAt.getTime() > thresholdMs
  if (!webhookIsStale) return false
  // A stale webhook doesn't matter if something else (a manual/agent
  // sync) already caught the repository up more recently than that.
  return !lastSyncedAt || lastSyncedAt < lastWebhookAt
}

/** Fallback freshness for git repositories a webhook can't reach (spec 8). */
export function startPollingScheduler(intervalMs: number, thresholdMs: number): () => void {
  const timer = setInterval(() => {
    void tick(thresholdMs)
  }, intervalMs)
  return () => clearInterval(timer)
}

async function tick(thresholdMs: number): Promise<void> {
  const candidates = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ingestionMethod, 'git'), ne(repositories.syncStatus, 'syncing')))

  const now = new Date()
  for (const repo of candidates) {
    if (!shouldPoll(repo.lastWebhookAt, repo.lastSyncedAt, now, thresholdMs)) continue
    try {
      await syncGitRepository(repo.id)
    } catch (err) {
      console.error(`polling sync failed for repository ${repo.id}:`, err)
    }
  }
}
