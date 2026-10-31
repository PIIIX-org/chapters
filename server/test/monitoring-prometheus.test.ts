// GET /api/admin/metrics: the monitoring store in the Prometheus text format,
// under the monitoring endpoint's access rule. The instruments move under
// real work: a search times each leg and the fusion, an extraction job times
// its extract, embed and write stages, and the sampler reads the pending jobs
// per kind from the `jobs` table.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { jobs } from '../src/db/schema.js'
import {
  INDEX_STAGES,
  instrumentSnapshot,
  resetInstruments,
  sampleEventLoop,
  type HistogramCounts,
  type IndexStage,
  type SearchLeg,
} from '../src/monitoring/metrics.js'
import { SAMPLE_INTERVAL_MS, jobQueueDepths, sampleOnce, startMetricsSampler } from '../src/monitoring/sampler.js'
import { createNote } from '../src/notes/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { findSymbols, searchNotes } from '../src/search/search.js'
import { createActiveUser, loginCookie } from './helpers.js'

const TOKEN = `prometheus-${'fedcba9876543210'.repeat(3)}`
const ENDPOINT = '/api/admin/metrics'

let app: FastifyInstance
let adminCookie: string
let memberCookie: string
let vaultId: string
let repoId: string

async function scrape(): Promise<string> {
  const res = await app.inject({ method: 'GET', url: ENDPOINT, headers: { authorization: `Bearer ${TOKEN}` } })
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
  expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8')
  expect(res.headers['cache-control']).toBe('no-store')
  return res.body
}

/** The value of the sample `name{labels}` in a scrape, or undefined when the series is absent. */
function series(text: string, name: string, labels = ''): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${name}${labels} `))
  return line === undefined ? undefined : Number(line.slice(name.length + labels.length + 1))
}

const legCounts = () => Object.fromEntries(Object.entries(instrumentSnapshot().searchLegs).map(([l, h]) => [l, h.count])) as Record<SearchLeg, number>

beforeAll(async () => {
  vi.stubEnv('ELARA_MONITORING_TOKEN', TOKEN)
  app = await buildApp()
  const admin = await createActiveUser({ role: 'admin' })
  const owner = await createActiveUser()
  adminCookie = await loginCookie(app, admin.email)
  memberCookie = await loginCookie(app, owner.email)
  const post = async (url: string, body: Record<string, unknown>) =>
    (await app.inject({ method: 'POST', url, headers: { cookie: memberCookie }, body })).json<{ id: string }>()
  vaultId = (await post('/api/vaults', { name: 'prometheus vault' })).id
  repoId = (await post('/api/repositories', { name: 'prometheus-repo', ingestionMethod: 'agent_push' })).id
  await createNote(vaultId, { path: 'ops/telemetry', body: 'telemetry '.repeat(40) })
  await flushEmbeddings()
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await app.close()
})

describe('GET /api/admin/metrics', () => {
  it('needs the monitoring token or an admin session, like /api/admin/monitoring', async () => {
    expect((await app.inject({ method: 'GET', url: ENDPOINT })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: ENDPOINT, headers: { authorization: `Bearer ${TOKEN}x` } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: ENDPOINT, headers: { cookie: memberCookie } })).statusCode).toBe(403)
    const admin = await app.inject({ method: 'GET', url: ENDPOINT, headers: { cookie: adminCookie } })
    expect(admin.statusCode).toBe(200)
    expect(admin.body).toContain('# TYPE elara_requests_total counter')
    expect(series(await scrape(), 'elara_requests_total')).toBeGreaterThan(0)
  })

  it('times every leg and the fusion of a search, and the embedding of its query', async () => {
    resetInstruments()
    const before = legCounts()
    const hits = await searchNotes({ vaultIds: [vaultId], repositoryIds: [repoId] }, 'telemetry', 10, {}, { includeSymbols: true })
    expect(hits.status).toBe('ok')
    expect(hits.retrieval_mode).toBe('hybrid')
    const after = legCounts()
    // One observation per leg that ran a query (the repository has no file yet, so its legs still run) and one fusion.
    for (const leg of ['note_keyword', 'code_keyword', 'symbol_keyword', 'note_vector', 'code_vector', 'symbol_vector', 'query_embed', 'fusion'] as const) {
      expect(after[leg] - before[leg], leg).toBe(1)
    }
    // A symbol-only search: its two legs and the fusion, nothing of the note or code legs.
    await findSymbols([repoId], 'telemetry')
    const symbolsOnly = legCounts()
    expect(symbolsOnly.symbol_keyword - after.symbol_keyword).toBe(1)
    expect(symbolsOnly.symbol_vector - after.symbol_vector).toBe(1)
    expect(symbolsOnly.fusion - after.fusion).toBe(1)
    expect(symbolsOnly.note_keyword - after.note_keyword).toBe(0)
    // An empty scope runs no leg and observes nothing.
    await searchNotes({ vaultIds: [], repositoryIds: [] }, 'telemetry')
    expect(legCounts()).toEqual(symbolsOnly)
    const text = await scrape()
    expect(series(text, 'elara_search_leg_duration_seconds_count', '{leg="note_vector"}')).toBe(1)
    expect(series(text, 'elara_search_leg_duration_seconds_bucket', '{leg="fusion",le="+Inf"}')).toBe(2)
    expect(series(text, 'elara_search_leg_duration_seconds_sum', '{leg="note_keyword"}')).toBeGreaterThan(0)
  })

  it('times the extract, embed and write stages of one file extraction', async () => {
    resetInstruments()
    const stages = (): Record<IndexStage, HistogramCounts> => instrumentSnapshot().indexStages
    const content = Array.from({ length: 4 }, (_, i) => `export function telemetryProbe${i}(input: string) {\n  return input + '${i}'\n}`).join('\n')
    await syncRepositoryFiles(repoId, [{ path: 'src/telemetry.ts', content }], ['src/telemetry.ts'])
    await flushExtraction()
    const first = stages()
    for (const stage of INDEX_STAGES) expect(first[stage].count, stage).toBe(1)
    expect(first.embed.sumMs).toBeGreaterThan(0)
    expect(first.write.sumMs).toBeGreaterThan(0)
    // The same content again with one new symbol: its old vectors are reused, only the new block is embedded.
    await syncRepositoryFiles(repoId, [{ path: 'src/telemetry.ts', content: `${content}\nexport const telemetryFlag = true\n` }], ['src/telemetry.ts'])
    await flushExtraction()
    const second = stages()
    expect(second.extract.count).toBe(2)
    expect(second.write.count).toBe(2)
    expect(second.embed.count).toBe(2)
    const text = await scrape()
    expect(series(text, 'elara_index_stage_duration_seconds_count', '{stage="extract"}')).toBe(2)
    expect(series(text, 'elara_index_stage_duration_seconds_bucket', '{stage="write",le="+Inf"}')).toBe(2)
    expect(series(text, 'elara_jobs_total', '{kind="extraction",outcome="succeeded"}')).toBeGreaterThanOrEqual(2)
  })

  it('samples the pending jobs per kind with the age of the oldest, and the process gauges', async () => {
    resetInstruments()
    // A pending job no drainer can claim (its last claim is leased for an hour) with a known age.
    const [job] = await db
      .insert(jobs)
      .values({
        kind: 'extract',
        payload: { fileId: '00000000-0000-0000-0000-000000000000', repositoryId: repoId },
        idempotencyKey: `prometheus-test:${Date.now()}`,
        attempts: 3,
        leaseUntil: new Date(Date.now() + 3_600_000),
        createdAt: new Date(Date.now() - 120_000),
      })
      .returning({ id: jobs.id })
    try {
      const depths = await jobQueueDepths()
      const extract = depths.find((d) => d.kind === 'extract')
      expect(extract?.pending).toBeGreaterThanOrEqual(1)
      expect(extract?.oldestAgeSeconds).toBeGreaterThanOrEqual(119)
      expect(extract?.oldestAgeSeconds).toBeLessThan(600)
      await sampleOnce()
      const text = await scrape()
      expect(series(text, 'elara_jobs_pending', '{kind="extract"}')).toBe(extract!.pending)
      expect(series(text, 'elara_jobs_oldest_pending_age_seconds', '{kind="extract"}')).toBeGreaterThanOrEqual(119)
      expect(series(text, 'elara_jobs_sample_timestamp_seconds')).toBeGreaterThan(1_700_000_000)
      expect(series(text, 'elara_process_resident_memory_bytes')).toBeGreaterThan(1_000_000)
      expect(series(text, 'elara_process_heap_used_bytes')).toBeGreaterThan(0)
    } finally {
      await db.execute(sql`DELETE FROM jobs WHERE id = ${job!.id}`)
    }
  })

  it('samples at once when started, then on its interval, and stops cleanly', async () => {
    resetInstruments()
    expect(SAMPLE_INTERVAL_MS).toBe(15_000)
    const stop = startMetricsSampler()
    try {
      // The first sample runs on start; its queue read is awaited by polling the gauge it sets.
      const deadline = Date.now() + 5_000
      while (instrumentSnapshot().jobQueue.sampledAt === 0 && Date.now() < deadline) await nextTurn()
      const snap = instrumentSnapshot()
      expect(snap.processMemory.rss).toBeGreaterThan(0)
      expect(snap.eventLoop.sampledAt).toBeGreaterThan(0)
      expect(snap.jobQueue.sampledAt).toBeGreaterThan(0)
    } finally {
      stop()
    }
    // After stop the event-loop sample is a no-op.
    const at = instrumentSnapshot().eventLoop.sampledAt
    sampleEventLoop(at + 1)
    expect(instrumentSnapshot().eventLoop.sampledAt).toBe(at)
  })
})
