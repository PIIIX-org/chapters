/**
 * Chroma Edition Performance & Scalability Benchmark
 * Measures vector ingestion throughput, query latency, kNN neighbor search,
 * and Reciprocal Rank Fusion (RRF) overhead.
 *
 * Run:
 *   pnpm --filter @elara/server exec tsx src/scripts/benchmark-chroma.ts
 */
import { performance } from 'node:perf_hooks'
import { MemoryVectorStore } from '../search/vector/memory-store.js'

function generateUnitVector(seed: number, dims = 384): number[] {
  const raw = Array.from({ length: dims }, (_, i) => Math.sin(seed + i * 0.05))
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0))
  return raw.map((v) => v / norm)
}

interface BenchmarkMetrics {
  ingest1000Ms: number
  ingestPerSec: number
  queryNotesLatencyMs: number
  knnLatencyMs: number
  rrfMergeLatencyUs: number
  memoryUsedMb: number
}

async function runBenchmark(): Promise<BenchmarkMetrics> {
  const store = new MemoryVectorStore()
  await store.init()

  const VECTOR_COUNT = 1000
  const VAULT_ID = '00000000-0000-4000-8000-000000000001'

  // 1. Ingestion Throughput
  const t0 = performance.now()
  for (let i = 0; i < VECTOR_COUNT; i++) {
    const id = `note-${i}`
    const vec = generateUnitVector(i)
    await store.upsertNote(
      id,
      vec,
      { vaultId: VAULT_ID, path: `notes/benchmark-${i}.md`, type: 'notes' },
      `Benchmark document content for item ${i} with searchable terms and entities.`,
    )
  }
  const t1 = performance.now()
  const ingestTimeMs = t1 - t0
  const ingestPerSec = Math.round((VECTOR_COUNT / (ingestTimeMs / 1000)))

  // 2. Query Latency (100 iterations)
  const queryVec = generateUnitVector(42)
  const QUERY_ROUNDS = 100
  const t2 = performance.now()
  for (let r = 0; r < QUERY_ROUNDS; r++) {
    await store.queryNotes(queryVec, [VAULT_ID], 30)
  }
  const t3 = performance.now()
  const avgQueryLatencyMs = (t3 - t2) / QUERY_ROUNDS

  // 3. kNN Semantic Neighbors (100 iterations)
  const t4 = performance.now()
  for (let r = 0; r < QUERY_ROUNDS; r++) {
    await store.knn(queryVec, 'note', 'note-0', 10)
  }
  const t5 = performance.now()
  const avgKnnLatencyMs = (t5 - t4) / QUERY_ROUNDS

  // 4. Reciprocal Rank Fusion (RRF k=60) Simulation
  const RRF_K = 60
  const FTS_CANDIDATES = Array.from({ length: 30 }, (_, i) => `doc-${i}`)
  const VEC_CANDIDATES = Array.from({ length: 30 }, (_, i) => `doc-${i % 2 === 0 ? i : i + 20}`)

  const t6 = performance.now()
  const RRF_ROUNDS = 1000
  for (let r = 0; r < RRF_ROUNDS; r++) {
    const scores = new Map<string, number>()
    for (let rank = 0; rank < FTS_CANDIDATES.length; rank++) {
      const id = FTS_CANDIDATES[rank]!
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1))
    }
    for (let rank = 0; rank < VEC_CANDIDATES.length; rank++) {
      const id = VEC_CANDIDATES[rank]!
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1))
    }
    Array.from(scores.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)
  }
  const t7 = performance.now()
  const avgRrfUs = ((t7 - t6) / RRF_ROUNDS) * 1000

  const mem = process.memoryUsage()
  const memoryUsedMb = Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10

  return {
    ingest1000Ms: Math.round(ingestTimeMs * 10) / 10,
    ingestPerSec,
    queryNotesLatencyMs: Math.round(avgQueryLatencyMs * 1000) / 1000,
    knnLatencyMs: Math.round(avgKnnLatencyMs * 1000) / 1000,
    rrfMergeLatencyUs: Math.round(avgRrfUs * 10) / 10,
    memoryUsedMb,
  }
}

const metrics = await runBenchmark()
console.log(JSON.stringify(metrics, null, 2))
