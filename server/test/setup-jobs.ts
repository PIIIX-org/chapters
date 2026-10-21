// Background jobs live in the shared test database (#494), not in a module
// that vitest re-creates per test file. Without this, jobs one file left
// pending (a sync it never flushed, a retry still in backoff) would run in
// the next file and land in its embedder mocks and timings. Each file starts
// with no pending job, as it did with the in-memory queues.
import { beforeAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'

beforeAll(async () => {
  await db.execute(sql`DELETE FROM jobs WHERE done_at IS NULL`)
})
