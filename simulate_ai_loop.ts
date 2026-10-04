import { performance } from 'node:perf_hooks'
import { execSync } from 'node:child_process'

interface RequestResult {
  status: number
  durationMs: number
  error?: string
}

interface TestRunSummary {
  scenario: string
  target: 'local' | 'live'
  surface: 'REST' | 'MCP'
  totalRequests: number
  successCount: number
  rateLimitedCount: number
  errorCount: number
  durationMs: number
  rps: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  minMs: number
  maxMs: number
  memoryDeltaMb?: number
  notes: string
}

const LOCAL_BASE = 'http://127.0.0.1:3001'
const LOCAL_VAULT_ID = '22222222-2222-4222-8222-222222222222'
const LOCAL_SID = 'local_session_cookie_token_1234567890abcdef1234567890abcdef'
const LOCAL_MCP_TOKEN = 'local_mcp_test_token_abcdef1234567890abcdef1234567890'

const LIVE_BASE = 'https://chapters.piiix.org'
const LIVE_VAULT_ID = 'c1e3c446-d3f9-4868-9716-44b9c3234e72'
const LIVE_SID = 'c0ffee00112233445566778899aabbccddeeff00112233445566778899aabbcc'
const LIVE_MCP_TOKEN = '26e078a8aafe74e5118d10470261b280e2a1fc28bef26d11efaa05eeeba5bbaf'

function calcStats(durations: number[]): { p50: number; p95: number; p99: number; min: number; max: number } {
  if (durations.length === 0) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0 }
  const sorted = [...durations].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0
  const min = sorted[0] ?? 0
  const max = sorted[sorted.length - 1] ?? 0
  return {
    p50: Number(p50.toFixed(2)),
    p95: Number(p95.toFixed(2)),
    p99: Number(p99.toFixed(2)),
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
  }
}

async function executeRestRead(baseUrl: string, vaultId: string, path: string, sid: string): Promise<RequestResult> {
  const url = `${baseUrl}/api/vaults/${vaultId}/notes/${path}`
  const start = performance.now()
  try {
    const res = await fetch(url, {
      headers: {
        Cookie: `sid=${sid}`,
        Accept: 'application/json',
      },
    })
    const durationMs = performance.now() - start
    return { status: res.status, durationMs }
  } catch (err) {
    return { status: 0, durationMs: performance.now() - start, error: (err as Error).message }
  }
}

async function executeMcpRead(baseUrl: string, vaultId: string, path: string, token: string): Promise<RequestResult> {
  const url = `${baseUrl}/mcp`
  const start = performance.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1000000),
        method: 'tools/call',
        params: {
          name: 'read_note',
          arguments: { vaultId, path },
        },
      }),
    })
    const durationMs = performance.now() - start
    return { status: res.status, durationMs }
  } catch (err) {
    return { status: 0, durationMs: performance.now() - start, error: (err as Error).message }
  }
}

async function checkHealth(baseUrl: string): Promise<{ ok: boolean; latencyMs: number }> {
  const start = performance.now()
  try {
    const res = await fetch(`${baseUrl}/health`)
    return { ok: res.ok, latencyMs: Number((performance.now() - start).toFixed(2)) }
  } catch {
    return { ok: false, latencyMs: Number((performance.now() - start).toFixed(2)) }
  }
}

// -------------------------------------------------------------
// Test Runners
// -------------------------------------------------------------

async function runSingleNoteTightLoop(
  target: 'local' | 'live',
  surface: 'REST' | 'MCP',
  count: number,
): Promise<TestRunSummary> {
  const baseUrl = target === 'local' ? LOCAL_BASE : LIVE_BASE
  const vaultId = target === 'local' ? LOCAL_VAULT_ID : LIVE_VAULT_ID
  const sid = target === 'local' ? LOCAL_SID : LIVE_SID
  const token = target === 'local' ? LOCAL_MCP_TOKEN : LIVE_MCP_TOKEN
  const notePath = target === 'local' ? 'concept/system-overview' : 'spec/chapters-map-okf-protocol'

  console.log(`\n======================================================`)
  console.log(`[START] ${target.toUpperCase()} - ${surface} Tight Loop: ${count} requests on ${notePath}`)
  console.log(`======================================================`)

  const results: RequestResult[] = []
  const startTime = performance.now()

  for (let i = 1; i <= count; i++) {
    const res = surface === 'REST'
      ? await executeRestRead(baseUrl, vaultId, notePath, sid)
      : await executeMcpRead(baseUrl, vaultId, notePath, token)

    results.push(res)

    if (i % 25 === 0 || i === count || res.status === 429) {
      process.stdout.write(`Req ${i}/${count}: HTTP ${res.status} (${res.durationMs.toFixed(1)}ms)\n`)
    }
  }

  const totalTime = performance.now() - startTime
  const durations = results.map((r) => r.durationMs)
  const stats = calcStats(durations)
  const successCount = results.filter((r) => r.status === 200).length
  const rateLimitedCount = results.filter((r) => r.status === 429).length
  const errorCount = results.filter((r) => r.status !== 200 && r.status !== 429).length
  const rps = Number(((results.length / totalTime) * 1000).toFixed(2))

  return {
    scenario: `Single Note Tight Loop (${count} reqs)`,
    target,
    surface,
    totalRequests: count,
    successCount,
    rateLimitedCount,
    errorCount,
    durationMs: Number(totalTime.toFixed(2)),
    rps,
    p50Ms: stats.p50,
    p95Ms: stats.p95,
    p99Ms: stats.p99,
    minMs: stats.min,
    maxMs: stats.max,
    notes: rateLimitedCount > 0 ? `Rate limited triggered at request #${results.findIndex(r => r.status === 429) + 1}` : 'No rate limit reached',
  }
}

async function runOscillatingLoop(
  target: 'local' | 'live',
  count: number,
): Promise<TestRunSummary> {
  const baseUrl = target === 'local' ? LOCAL_BASE : LIVE_BASE
  const vaultId = target === 'local' ? LOCAL_VAULT_ID : LIVE_VAULT_ID
  const sid = target === 'local' ? LOCAL_SID : LIVE_SID

  const notes = target === 'local'
    ? ['concept/system-overview', 'concept/data-flow', 'spec/large-document']
    : ['spec/chapters-map-okf-protocol', 'audit/2026-10-01-comprehensive-live-system-and-bottleneck-audit', 'design/observatory-bridge']

  console.log(`\n======================================================`)
  console.log(`[START] ${target.toUpperCase()} - REST Oscillating Loop across ${notes.length} notes (${count} total requests)`)
  console.log(`======================================================`)

  const results: RequestResult[] = []
  const startTime = performance.now()

  for (let i = 1; i <= count; i++) {
    const path = notes[(i - 1) % notes.length]!
    const res = await executeRestRead(baseUrl, vaultId, path, sid)
    results.push(res)
    if (i % 50 === 0 || i === count) {
      process.stdout.write(`Req ${i}/${count} (${path}): HTTP ${res.status} (${res.durationMs.toFixed(1)}ms)\n`)
    }
  }

  const totalTime = performance.now() - startTime
  const stats = calcStats(results.map((r) => r.durationMs))
  const successCount = results.filter((r) => r.status === 200).length
  const rateLimitedCount = results.filter((r) => r.status === 429).length
  const errorCount = results.filter((r) => r.status !== 200 && r.status !== 429).length
  const rps = Number(((results.length / totalTime) * 1000).toFixed(2))

  return {
    scenario: `Oscillating Graph Loop (${notes.length} notes, ${count} reqs)`,
    target,
    surface: 'REST',
    totalRequests: count,
    successCount,
    rateLimitedCount,
    errorCount,
    durationMs: Number(totalTime.toFixed(2)),
    rps,
    p50Ms: stats.p50,
    p95Ms: stats.p95,
    p99Ms: stats.p99,
    minMs: stats.min,
    maxMs: stats.max,
    notes: 'Rotates across 3 linked notes in a tight cycle',
  }
}

async function run404HallucinationLoop(
  target: 'local' | 'live',
  count: number,
): Promise<TestRunSummary> {
  const baseUrl = target === 'local' ? LOCAL_BASE : LIVE_BASE
  const vaultId = target === 'local' ? LOCAL_VAULT_ID : LIVE_VAULT_ID
  const sid = target === 'local' ? LOCAL_SID : LIVE_SID
  const fakePath = 'concept/hallucinated-glitch-note-404'

  console.log(`\n======================================================`)
  console.log(`[START] ${target.toUpperCase()} - 404 Hallucination Loop: ${count} requests on missing note`)
  console.log(`======================================================`)

  const results: RequestResult[] = []
  const startTime = performance.now()

  for (let i = 1; i <= count; i++) {
    const res = await executeRestRead(baseUrl, vaultId, fakePath, sid)
    results.push(res)
  }

  const totalTime = performance.now() - startTime
  const stats = calcStats(results.map((r) => r.durationMs))
  const notFoundCount = results.filter((r) => r.status === 404).length
  const rateLimitedCount = results.filter((r) => r.status === 429).length
  const errorCount = results.filter((r) => r.status !== 404 && r.status !== 429).length
  const rps = Number(((results.length / totalTime) * 1000).toFixed(2))

  return {
    scenario: `404 Missing Note Loop (${count} reqs)`,
    target,
    surface: 'REST',
    totalRequests: count,
    successCount: notFoundCount, // 404 is the expected success here
    rateLimitedCount,
    errorCount,
    durationMs: Number(totalTime.toFixed(2)),
    rps,
    p50Ms: stats.p50,
    p95Ms: stats.p95,
    p99Ms: stats.p99,
    minMs: stats.min,
    maxMs: stats.max,
    notes: `${notFoundCount} notes returned 404 cleanly; test evaluates error overhead`,
  }
}

async function runConcurrentSwarmLoop(
  target: 'local' | 'live',
  concurrency: number,
  requestsPerWorker: number,
): Promise<{ summary: TestRunSummary; healthDuringStress: { ok: boolean; latencyMs: number } }> {
  const baseUrl = target === 'local' ? LOCAL_BASE : LIVE_BASE
  const vaultId = target === 'local' ? LOCAL_VAULT_ID : LIVE_VAULT_ID
  const sid = target === 'local' ? LOCAL_SID : LIVE_SID
  const notePath = target === 'local' ? 'concept/system-overview' : 'spec/chapters-map-okf-protocol'
  const totalRequests = concurrency * requestsPerWorker

  console.log(`\n======================================================`)
  console.log(`[START] ${target.toUpperCase()} - Concurrent Swarm: ${concurrency} parallel AI workers, ${requestsPerWorker} reqs each (${totalRequests} total)`)
  console.log(`======================================================`)

  const startTime = performance.now()
  const allResults: RequestResult[] = []

  let healthCheckResult: { ok: boolean; latencyMs: number } = { ok: false, latencyMs: 0 }

  const workerPromises = Array.from({ length: concurrency }).map(async (_, workerIdx) => {
    const workerResults: RequestResult[] = []
    for (let i = 0; i < requestsPerWorker; i++) {
      const res = await executeRestRead(baseUrl, vaultId, notePath, sid)
      workerResults.push(res)
    }
    return workerResults
  })

  // Measure health during active stress
  const healthPromise = (async () => {
    await new Promise((r) => setTimeout(r, 200)) // let workers ramp up
    return await checkHealth(baseUrl)
  })()

  const [workerOutputs, healthOutput] = await Promise.all([
    Promise.all(workerPromises),
    healthPromise,
  ])

  healthCheckResult = healthOutput
  for (const w of workerOutputs) {
    allResults.push(...w)
  }

  const totalTime = performance.now() - startTime
  const stats = calcStats(allResults.map((r) => r.durationMs))
  const successCount = allResults.filter((r) => r.status === 200).length
  const rateLimitedCount = allResults.filter((r) => r.status === 429).length
  const errorCount = allResults.filter((r) => r.status !== 200 && r.status !== 429).length
  const rps = Number(((allResults.length / totalTime) * 1000).toFixed(2))

  return {
    summary: {
      scenario: `Concurrent Swarm (C=${concurrency}, ${totalRequests} reqs)`,
      target,
      surface: 'REST',
      totalRequests,
      successCount,
      rateLimitedCount,
      errorCount,
      durationMs: Number(totalTime.toFixed(2)),
      rps,
      p50Ms: stats.p50,
      p95Ms: stats.p95,
      p99Ms: stats.p99,
      minMs: stats.min,
      maxMs: stats.max,
      notes: `Healthcheck during swarm: ${healthOutput.ok ? 'HEALTHY' : 'UNHEALTHY'} (${healthOutput.latencyMs}ms)`,
    },
    healthDuringStress: healthCheckResult,
  }
}

// -------------------------------------------------------------
// Main Test Orchestrator
// -------------------------------------------------------------

async function main() {
  console.log('############################################################')
  console.log('### RUNAWAY AI AGENT NOTE NAVIGATION SIMULATION SUITE    ###')
  console.log('############################################################')

  const summaries: TestRunSummary[] = []

  // Check health before tests
  const initialLocalHealth = await checkHealth(LOCAL_BASE)
  const initialLiveHealth = await checkHealth(LIVE_BASE)
  console.log(`Baseline Health -> Local: ${initialLocalHealth.ok} (${initialLocalHealth.latencyMs}ms) | Live: ${initialLiveHealth.ok} (${initialLiveHealth.latencyMs}ms)`)

  // ==========================================
  // PHASE A: LOCAL SERVER EXPERIMENTS
  // ==========================================
  console.log('\n>>> Commencing Phase A: Local Server Experiments...')

  // 1. Local MCP Tool read_note loop (testing MCP 120 req/min limit)
  summaries.push(await runSingleNoteTightLoop('local', 'MCP', 135))

  // 2. Local REST read loop (150 requests)
  summaries.push(await runSingleNoteTightLoop('local', 'REST', 150))

  // 3. Local REST Oscillating graph loop (150 requests)
  summaries.push(await runOscillatingLoop('local', 150))

  // 4. Local 404 Hallucination loop (100 requests)
  summaries.push(await run404HallucinationLoop('local', 100))

  // 5. Local Concurrent Swarm (C=10, 20 reqs each = 200 reqs)
  const localSwarm = await runConcurrentSwarmLoop('local', 10, 20)
  summaries.push(localSwarm.summary)

  // ==========================================
  // PHASE B: LIVE PRODUCTION EXPERIMENTS
  // ==========================================
  console.log('\n>>> Commencing Phase B: Live Production Experiments...')

  // 1. Live MCP Tool read_note loop (testing MCP rate limit live)
  summaries.push(await runSingleNoteTightLoop('live', 'MCP', 130))

  // 2. Live REST read loop (150 requests)
  summaries.push(await runSingleNoteTightLoop('live', 'REST', 150))

  // 3. Live REST Oscillating graph loop (150 requests)
  summaries.push(await runOscillatingLoop('live', 150))

  // 4. Live 404 Hallucination loop (100 requests)
  summaries.push(await run404HallucinationLoop('live', 100))

  // 5. Live Concurrent Swarm (C=10, 20 reqs each = 200 reqs)
  const liveSwarm = await runConcurrentSwarmLoop('live', 10, 20)
  summaries.push(liveSwarm.summary)

  // Post-test health verification
  const finalLocalHealth = await checkHealth(LOCAL_BASE)
  const finalLiveHealth = await checkHealth(LIVE_BASE)

  console.log('\n############################################################')
  console.log('### FINAL CONSOLIDATED BENCHMARK SUMMARY                 ###')
  console.log('############################################################')
  console.table(summaries)

  console.log(`\nPost-Test Health -> Local: ${finalLocalHealth.ok} (${finalLocalHealth.latencyMs}ms) | Live: ${finalLiveHealth.ok} (${finalLiveHealth.latencyMs}ms)`)

  const fs = await import('node:fs')
  fs.writeFileSync('ai_loop_simulation_results.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    baseline: { local: initialLocalHealth, live: initialLiveHealth },
    postTest: { local: finalLocalHealth, live: finalLiveHealth },
    summaries,
  }, null, 2))
  console.log('Saved detailed results to ai_loop_simulation_results.json')
}

main().catch(console.error)

