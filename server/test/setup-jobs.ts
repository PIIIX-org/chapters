// Background jobs live in the shared test database (#494), not in a module
// that vitest re-creates per test file. Without this, jobs one file left
// pending (a sync it never flushed, a retry still in backoff) would run in
// the next file and land in its embedder mocks and timings. Each file starts
// with no pending job, as it did with the in-memory queues.
//
// Note files are projections written after commit (ADR-003 §7): every file
// flushes the projector when it ends, so CI's `check-notes --fail-on-pending`
// finds every file the suite's notes need.
//
// Query vectors are cached per process (#684): each test starts with none, so
// a test that mocks the embedder (to fail it, or to count calls) sees every
// query instead of a vector an earlier test cached.
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { flushProjections } from '../src/notes/projector.js'
import { queryEmbeddings } from '../src/search/embeddings.js'

beforeAll(async () => {
  await db.execute(sql`DELETE FROM jobs WHERE done_at IS NULL AND kind NOT LIKE 'store\\_%'`)
})

beforeEach(() => {
  queryEmbeddings.clear()
})

afterAll(async () => {
  await flushProjections()
})
