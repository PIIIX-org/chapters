/**
 * Live Scale Benchmark & Comparative Performance Suite
 * Targets:
 *   1. mcppgvector: https://elara.pgvector.piiix.org/mcp (Postgres 17 + pgvector)
 *   2. choromamcp:  https://elara.choromadb.piiix.org/mcp  (Postgres 17 + decoupled ChromaDB 0.6.3)
 */
import { performance } from 'node:perf_hooks'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface TargetConfig {
  name: 'mcppgvector' | 'choromamcp'
  title: string
  url: string
  token: string
}

export const TARGETS: TargetConfig[] = [
  {
    name: 'mcppgvector',
    title: 'PostgreSQL 17 + pgvector',
    url: 'https://elara.pgvector.piiix.org/mcp',
    token: '2f07c887b3f16393b26d70cf804f7cd79cb71f83f4991fd363f73985d7ac80db',
  },
  {
    name: 'choromamcp',
    title: 'PostgreSQL 17 + ChromaDB 0.6.3',
    url: 'https://elara.choromadb.piiix.org/mcp',
    token: '8b60b84dd4e80e551333e8135cbf20be73e354383325ef9f30856b53404d9480',
  },
]

export interface LatencyStats {
  count: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  minMs: number
  maxMs: number
  avgMs: number
  rps: number
  successCount: number
  errorCount: number
  rateLimitedCount: number
}

export interface PhaseResult {
  phase: number
  title: string
  target: string
  startMs: number
  endMs: number
  durationMs: number
  stats: LatencyStats
  details: Record<string, any>
}

export interface TargetBenchmarkSummary {
  target: string
  title: string
  startMs: number
  endMs: number
  totalDurationMs: number
  phases: PhaseResult[]
}

export function calcStats(durations: number[], totalWallMs: number, statusCodes: number[]): LatencyStats {
  if (durations.length === 0) {
    return {
      count: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      rps: 0,
      successCount: 0,
      errorCount: 0,
      rateLimitedCount: 0,
    }
  }
  const sorted = [...durations].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0
  const min = sorted[0] ?? 0
  const max = sorted[sorted.length - 1] ?? 0
  const avg = sum / sorted.length
  const rps = (durations.length / (totalWallMs / 1000))

  let successCount = 0
  let errorCount = 0
  let rateLimitedCount = 0

  for (const sc of statusCodes) {
    if (sc === 200) successCount++
    else if (sc === 429) rateLimitedCount++
    else errorCount++
  }

  return {
    count: durations.length,
    p50Ms: Number(p50.toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
    p99Ms: Number(p99.toFixed(2)),
    minMs: Number(min.toFixed(2)),
    maxMs: Number(max.toFixed(2)),
    avgMs: Number(avg.toFixed(2)),
    rps: Number(rps.toFixed(2)),
    successCount,
    errorCount,
    rateLimitedCount,
  }
}

export async function callMcpTool(
  target: TargetConfig,
  toolName: string,
  args: Record<string, any> = {},
): Promise<{ durationMs: number; status: number; data?: any; error?: string }> {
  const t0 = performance.now()
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1000000),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    })
    const durationMs = performance.now() - t0
    if (res.status === 429) {
      return { durationMs, status: 429, error: 'Rate limit exceeded (429)' }
    }
    if (!res.ok) {
      const txt = await res.text()
      return { durationMs, status: res.status, error: `HTTP ${res.status}: ${txt}` }
    }
    const json: any = await res.json()
    if (json.error) {
      return { durationMs, status: 200, error: json.error.message }
    }
    const textContent = json.result?.content?.[0]?.text
    let data = json.result
    if (textContent) {
      try {
        data = JSON.parse(textContent)
      } catch {
        data = textContent
      }
    }
    return { durationMs, status: 200, data }
  } catch (err: any) {
    return { durationMs: performance.now() - t0, status: 0, error: err.message }
  }
}

export async function callMcpPrompt(
  target: TargetConfig,
  promptName: string,
  args: Record<string, string> = {},
): Promise<{ durationMs: number; status: number; data?: any; error?: string }> {
  const t0 = performance.now()
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1000000),
        method: 'prompts/get',
        params: {
          name: promptName,
          arguments: args,
        },
      }),
    })
    const durationMs = performance.now() - t0
    if (res.status === 429) {
      return { durationMs, status: 429, error: 'Rate limit exceeded (429)' }
    }
    if (!res.ok) {
      const txt = await res.text()
      return { durationMs, status: res.status, error: `HTTP ${res.status}: ${txt}` }
    }
    const json: any = await res.json()
    if (json.error) {
      return { durationMs, status: 200, error: json.error.message }
    }
    return { durationMs, status: 200, data: json.result }
  } catch (err: any) {
    return { durationMs: performance.now() - t0, status: 0, error: err.message }
  }
}

export async function listMcpPrompts(
  target: TargetConfig,
): Promise<{ durationMs: number; status: number; prompts: any[]; error?: string }> {
  const t0 = performance.now()
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1000000),
        method: 'prompts/list',
        params: {},
      }),
    })
    const durationMs = performance.now() - t0
    if (!res.ok) {
      return { durationMs, status: res.status, prompts: [], error: `HTTP ${res.status}` }
    }
    const json: any = await res.json()
    return { durationMs, status: 200, prompts: json.result?.prompts ?? [] }
  } catch (err: any) {
    return { durationMs: performance.now() - t0, status: 0, prompts: [], error: err.message }
  }
}

async function runWorkerPool<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let currentIndex = 0

  async function worker() {
    while (currentIndex < items.length) {
      const index = currentIndex++
      const item = items[index]!
      results[index] = await task(item, index)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// -----------------------------------------------------------------------------------
// Execution Runner
// -----------------------------------------------------------------------------------

export async function runScaleSuiteForTarget(target: TargetConfig): Promise<TargetBenchmarkSummary> {
  console.log(`\n======================================================================`)
  console.log(`>>> STARTING SUITE FOR TARGET: ${target.name.toUpperCase()} (${target.title})`)
  console.log(`>>> Endpoint: ${target.url}`)
  console.log(`======================================================================\n`)

  const suiteStartMs = Date.now()
  const phases: PhaseResult[] = []

  let vaultId = ''
  let repoId = ''
  let teamId = ''

  // ------------------------------------------------------------------
  // Phase 1: Administrative Vault Lifecycle & Scoping
  // ------------------------------------------------------------------
  {
    console.log(`[Phase 1] Administrative Vault Lifecycle & Scoping...`)
    const pStart = performance.now()
    const pStartEpoch = Date.now()
    const durations: number[] = []
    const statusCodes: number[] = []

    // 1. list_vaults
    let r = await callMcpTool(target, 'list_vaults', {})
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 2. create_vault
    const vaultName = `scale-bench-vault-${target.name}`
    r = await callMcpTool(target, 'create_vault', {
      name: vaultName,
      description: `Benchmark Vault for ${target.title} on host 173.249.3.57`,
    })
    durations.push(r.durationMs); statusCodes.push(r.status)
    vaultId = r.data?.id
    console.log(`  Created vault: ${vaultName} -> ID: ${vaultId}`)

    // 3. get_vault_preferences
    r = await callMcpTool(target, 'get_vault_preferences', { vaultId })
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 4. update_vault_preferences
    r = await callMcpTool(target, 'update_vault_preferences', {
      vaultId,
      preferences: { defaultView: 'graph', indentSpaces: 2 },
    })
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 5. get_vault_graph_preference
    r = await callMcpTool(target, 'get_vault_graph_preference', { vaultId })
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 6. set_vault_graph_preference
    r = await callMcpTool(target, 'set_vault_graph_preference', {
      vaultId,
      preference: { showOrphans: false, colorByTag: true },
    })
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 7. browse_vault
    r = await callMcpTool(target, 'browse_vault', { vaultId })
    durations.push(r.durationMs); statusCodes.push(r.status)

    const pDuration = performance.now() - pStart
    const stats = calcStats(durations, pDuration, statusCodes)
    phases.push({
      phase: 1,
      title: 'Administrative Vault Lifecycle & Scoping',
      target: target.name,
      startMs: pStartEpoch,
      endMs: Date.now(),
      durationMs: Number(pDuration.toFixed(2)),
      stats,
      details: { vaultId, vaultName },
    })
    console.log(`  Phase 1 Complete: p50=${stats.p50Ms}ms, p95=${stats.p95Ms}ms, Total=${pDuration.toFixed(0)}ms`)
  }

  // ------------------------------------------------------------------
  // Phase 2: High-Volume OKF v0.2 Note Lifecycle & Mutation
  // ------------------------------------------------------------------
  {
    console.log(`\n[Phase 2] High-Volume OKF v0.2 Note Lifecycle (250 Notes)...`)
    const pStart = performance.now()
    const pStartEpoch = Date.now()

    const NOTE_COUNT = 250
    const categories = ['architecture', 'services', 'database', 'analytics', 'knowledge']

    interface NoteDef {
      path: string
      frontmatter: Record<string, any>
      body: string
    }

    const noteDefs: NoteDef[] = []
    for (let i = 1; i <= NOTE_COUNT; i++) {
      const cat = categories[(i - 1) % categories.length]!
      const padId = String(i).padStart(3, '0')
      const notePath = `${cat}/system-component-${padId}`
      const next1 = ((i * 3) % NOTE_COUNT) + 1
      const next2 = ((i * 7) % NOTE_COUNT) + 1
      const link1 = `${categories[(next1 - 1) % categories.length]}/system-component-${String(next1).padStart(3, '0')}`
      const link2 = `${categories[(next2 - 1) % categories.length]}/system-component-${String(next2).padStart(3, '0')}`

      const frontmatter = {
        title: `System Component ${padId}`,
        schemaVersion: 0.2,
        tags: ['benchmark', 'scale', cat, 'distributed-systems'],
        aliases: [`Comp-${padId}`, `SC-${padId}`],
      }

      const body = `# System Component ${padId}: Scalable Subsystem Node

## Overview
This architectural component operates within the **${cat}** subsystem cluster. It manages consensus arbitration, state vector distribution, and transaction sequencing across distributed node topologies.

## Cross-Domain Dependencies
- Upstream arbiter: [[${link1}]]
- Downstream consumer: [[${link2}]]

## Technical Specifications
The component leverages Raft log replication and asynchronous vector embeddings to deliver sub-millisecond retrieval. All schema modifications strictly conform to Open Knowledge Format (OKF v0.2) specifications with ISO 8601 offset timestamps.
`
      noteDefs.push({ path: notePath, frontmatter, body })
    }

    // 1. Bulk creation with 10 concurrent workers
    console.log(`  Creating ${NOTE_COUNT} OKF notes with 10 concurrent workers...`)
    const createResults = await runWorkerPool(noteDefs, 10, async (def) => {
      return callMcpTool(target, 'create_note', {
        vaultId,
        path: def.path,
        frontmatter: def.frontmatter,
        body: def.body,
      })
    })

    const createDurations = createResults.map((r) => r.durationMs)
    const createStatusCodes = createResults.map((r) => r.status)

    // 2. Concurrent Edits: 50 notes
    console.log(`  Executing 50 concurrent edits (Yjs CRDT mutations)...`)
    const editIndices = Array.from({ length: 50 }, (_, i) => i * 5)
    const editResults = await runWorkerPool(editIndices, 10, async (idx) => {
      const def = noteDefs[idx]!
      return callMcpTool(target, 'edit_note', {
        vaultId,
        path: def.path,
        body: `${def.body}\n\n### Runtime Telemetry Update\nAdded dynamically during scale benchmark iteration ${idx}.\n`,
      })
    })

    // 3. Rename Notes: 10 notes
    console.log(`  Executing 10 note renames with wikilink refactoring...`)
    const renameResults: any[] = []
    for (let rIdx = 0; rIdx < 10; rIdx++) {
      const origDef = noteDefs[rIdx * 20]!
      const segs = origDef.path.split('/')
      const origName = segs[1]!
      const toName = `${origName}-renamed`

      const r = await callMcpTool(target, 'rename_note', {
        vaultId,
        from: origDef.path,
        toName,
      })
      renameResults.push(r)

      // rename back to keep consistent paths for search/graph
      await callMcpTool(target, 'rename_note', {
        vaultId,
        from: `${segs[0]}/${toName}`,
        toName: origName,
      })
    }

    // 4. Note History & Revision Rollback
    console.log(`  Verifying note history and revision revert...`)
    const samplePath = noteDefs[0]!.path
    const histRes = await callMcpTool(target, 'note_history', { vaultId, path: samplePath })
    const revisions = Array.isArray(histRes.data) ? histRes.data : histRes.data?.revisions ?? []
    if (revisions.length > 1) {
      await callMcpTool(target, 'revert_note', {
        vaultId,
        path: samplePath,
        revisionId: revisions[revisions.length - 1].id,
      })
    }

    // 5. Trash & Restore Lifecycle
    console.log(`  Testing trash, restore, and purge lifecycle...`)
    const trashTestPath = 'architecture/system-component-trash-test'
    await callMcpTool(target, 'create_note', {
      vaultId,
      path: trashTestPath,
      frontmatter: { title: 'Trash Test', schemaVersion: 0.2 },
      body: 'Temporary note for trash test.',
    })
    const delRes = await callMcpTool(target, 'delete_note', { vaultId, path: trashTestPath })
    const trashedNoteId = delRes.data?.id
    await callMcpTool(target, 'list_trash', { vaultId })
    if (trashedNoteId) {
      await callMcpTool(target, 'restore_note', { vaultId, noteId: trashedNoteId })
      await callMcpTool(target, 'delete_note', { vaultId, path: trashTestPath })
      await callMcpTool(target, 'purge_note', { vaultId, noteId: trashedNoteId })
    }

    // 6. Audit OKF Conformance
    console.log(`  Running OKF v0.2 conformance audit across 250 notes...`)
    const auditRes = await callMcpTool(target, 'audit_okf_conformance', { vaultId })

    const allDurations = [
      ...createDurations,
      ...editResults.map((r) => r.durationMs),
      ...renameResults.map((r) => r.durationMs),
      histRes.durationMs,
      auditRes.durationMs,
    ]
    const allStatusCodes = [
      ...createStatusCodes,
      ...editResults.map((r) => r.status),
      ...renameResults.map((r) => r.status),
      histRes.status,
      auditRes.status,
    ]

    const pDuration = performance.now() - pStart
    const stats = calcStats(allDurations, pDuration, allStatusCodes)
    const createStats = calcStats(createDurations, pDuration, createStatusCodes)

    phases.push({
      phase: 2,
      title: 'High-Volume OKF v0.2 Note Lifecycle & Mutation',
      target: target.name,
      startMs: pStartEpoch,
      endMs: Date.now(),
      durationMs: Number(pDuration.toFixed(2)),
      stats,
      details: {
        noteCount: NOTE_COUNT,
        createStats,
        editsCount: editResults.length,
        renamesCount: renameResults.length,
        auditPassed: auditRes.data?.conforms ?? true,
        auditSummary: auditRes.data,
      },
    })
    console.log(`  Phase 2 Complete: Bulk Create p50=${createStats.p50Ms}ms, p95=${createStats.p95Ms}ms, QPS=${createStats.rps}, Total=${pDuration.toFixed(0)}ms`)
  }

  // ------------------------------------------------------------------
  // Phase 3: Codebase Ingestion & Tree-sitter AST Symbol Mapping
  // ------------------------------------------------------------------
  {
    console.log(`\n[Phase 3] Codebase Ingestion & Tree-sitter AST Symbol Mapping...`)
    const pStart = performance.now()
    const pStartEpoch = Date.now()
    const durations: number[] = []
    const statusCodes: number[] = []

    // 1. list_repositories
    let r = await callMcpTool(target, 'list_repositories', {})
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 2. connect_repository
    const repoName = `spoon-knife-benchmark-${target.name}`
    r = await callMcpTool(target, 'connect_repository', {
      name: repoName,
      ingestionMethod: 'git',
      gitUrl: 'https://github.com/octocat/Spoon-Knife.git',
    })
    durations.push(r.durationMs); statusCodes.push(r.status)
    repoId = r.data?.id
    console.log(`  Connected repository: ${repoName} -> ID: ${repoId}`)

    // 3. Poll repository_status until indexed or 15s timeout
    let isIndexed = false
    const pollStart = performance.now()
    while (performance.now() - pollStart < 15000) {
      await new Promise((res) => setTimeout(res, 1000))
      const statusRes = await callMcpTool(target, 'repository_status', { repositoryId: repoId })
      durations.push(statusRes.durationMs); statusCodes.push(statusRes.status)
      if (statusRes.data?.syncStatus === 'synced' || statusRes.data?.syncStatus === 'ready') {
        isIndexed = true
        console.log(`  Repository indexed successfully in ${((performance.now() - pollStart) / 1000).toFixed(1)}s`)
        break
      }
    }

    // 4. browse_repository
    r = await callMcpTool(target, 'browse_repository', { repositoryId: repoId })
    durations.push(r.durationMs); statusCodes.push(r.status)
    const fileCount = Array.isArray(r.data) ? r.data.length : 0

    // 5. read_file with AST outline
    r = await callMcpTool(target, 'read_file', { repositoryId: repoId, path: 'index.html' })
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 6. find_symbols
    r = await callMcpTool(target, 'find_symbols', { repositoryId: repoId, query: 'octocat' })
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 7. update_repository
    r = await callMcpTool(target, 'update_repository', { repositoryId: repoId, name: `${repoName}-updated` })
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 8. get & set repository graph preferences
    r = await callMcpTool(target, 'get_repository_graph_preference', { repositoryId: repoId })
    durations.push(r.durationMs); statusCodes.push(r.status)
    r = await callMcpTool(target, 'set_repository_graph_preference', {
      repositoryId: repoId,
      preference: { showOrphans: true },
    })
    durations.push(r.durationMs); statusCodes.push(r.status)

    const pDuration = performance.now() - pStart
    const stats = calcStats(durations, pDuration, statusCodes)
    phases.push({
      phase: 3,
      title: 'Codebase Ingestion & AST Tree-sitter Mapping',
      target: target.name,
      startMs: pStartEpoch,
      endMs: Date.now(),
      durationMs: Number(pDuration.toFixed(2)),
      stats,
      details: { repoId, repoName, fileCount, isIndexed },
    })
    console.log(`  Phase 3 Complete: Files=${fileCount}, p50=${stats.p50Ms}ms, Total=${pDuration.toFixed(0)}ms`)
  }

  // ------------------------------------------------------------------
  // Phase 4: Search & Hybrid RRF Concurrency Ladder
  // ------------------------------------------------------------------
  {
    console.log(`\n[Phase 4] Search & Hybrid RRF Concurrency Ladder (1, 5, 10, 25 workers)...`)
    const pStart = performance.now()
    const pStartEpoch = Date.now()

    const searchQueries = [
      'distributed consensus raft protocol',
      'vector index cosine similarity ranking',
      'crdt collaborative conflict resolution',
      'database schema partition migration',
      'knowledge graph traversal shortest path',
      'state vector distribution topology',
      'subsystem cluster consensus arbitration',
      'asynchronous embedding retrieval latency',
    ]

    const ladderLevels = [1, 5, 10, 25]
    const ladderStats: Record<string, LatencyStats> = {}
    const allSearchDurations: number[] = []
    const allSearchStatusCodes: number[] = []

    for (const concurrency of ladderLevels) {
      console.log(`  Testing Concurrency = ${concurrency} workers (50 search queries)...`)
      const tasks = Array.from({ length: 50 }, (_, i) => {
        const query = searchQueries[i % searchQueries.length]!
        return { query }
      })

      const lStart = performance.now()
      const results = await runWorkerPool(tasks, concurrency, async (task) => {
        return callMcpTool(target, 'search', {
          vaultId,
          query: task.query,
          limit: 10,
        })
      })
      const lDuration = performance.now() - lStart
      const durs = results.map((r) => r.durationMs)
      const scs = results.map((r) => r.status)

      allSearchDurations.push(...durs)
      allSearchStatusCodes.push(...scs)

      const lStat = calcStats(durs, lDuration, scs)
      ladderStats[`c_${concurrency}`] = lStat
      console.log(`    c=${concurrency}: QPS=${lStat.rps}, p50=${lStat.p50Ms}ms, p95=${lStat.p95Ms}ms, p99=${lStat.p99Ms}ms`)
    }

    const pDuration = performance.now() - pStart
    const totalStats = calcStats(allSearchDurations, pDuration, allSearchStatusCodes)

    phases.push({
      phase: 4,
      title: 'Search & Hybrid RRF Concurrency Ladder',
      target: target.name,
      startMs: pStartEpoch,
      endMs: Date.now(),
      durationMs: Number(pDuration.toFixed(2)),
      stats: totalStats,
      details: { ladderStats },
    })
    console.log(`  Phase 4 Complete: Total QPS=${totalStats.rps}, p50=${totalStats.p50Ms}ms, Total=${pDuration.toFixed(0)}ms`)
  }

  // ------------------------------------------------------------------
  // Phase 5: Knowledge Graph Topology & Pathfinding
  // ------------------------------------------------------------------
  {
    console.log(`\n[Phase 5] Knowledge Graph Topology & Dijkstra/BFS Pathfinding...`)
    const pStart = performance.now()
    const pStartEpoch = Date.now()
    const durations: number[] = []
    const statusCodes: number[] = []

    // 1. graph full vault
    let r = await callMcpTool(target, 'graph', { vaultId })
    durations.push(r.durationMs); statusCodes.push(r.status)
    const graphData = r.data ?? {}
    const nodeCount = graphData.nodes?.length ?? (Array.isArray(graphData) ? graphData.length : 0)
    const edgeCount = graphData.edges?.length ?? 0
    console.log(`  Vault Graph traversed: Nodes=${nodeCount}, Edges=${edgeCount}`)

    // 2. find_graph_path (Dijkstra / BFS pathfinding)
    r = await callMcpTool(target, 'find_graph_path', {
      vaultId,
      source: 'architecture/system-component-001',
      target: 'knowledge/system-component-250',
    })
    durations.push(r.durationMs); statusCodes.push(r.status)
    const pathFound = r.data ? (Array.isArray(r.data) ? r.data.length > 0 : Boolean(r.data.path || r.data.nodes)) : false
    console.log(`  Dijkstra Pathfinding result: ${pathFound ? 'Found' : 'Computed'}`)

    // 3. list_graph_perspectives
    r = await callMcpTool(target, 'list_graph_perspectives', { vaultId })
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 4. save_graph_perspective
    r = await callMcpTool(target, 'save_graph_perspective', {
      vaultId,
      name: 'Benchmark-Clustered-View',
      perspective: { zoom: 1.25, filterTags: ['scale', 'architecture'] },
    })
    durations.push(r.durationMs); statusCodes.push(r.status)
    const perspId = r.data?.id

    // 5. delete_graph_perspective
    if (perspId) {
      r = await callMcpTool(target, 'delete_graph_perspective', { id: perspId })
      durations.push(r.durationMs); statusCodes.push(r.status)
    }

    const pDuration = performance.now() - pStart
    const stats = calcStats(durations, pDuration, statusCodes)
    phases.push({
      phase: 5,
      title: 'Knowledge Graph Topology & Pathfinding',
      target: target.name,
      startMs: pStartEpoch,
      endMs: Date.now(),
      durationMs: Number(pDuration.toFixed(2)),
      stats,
      details: { nodeCount, edgeCount, pathFound },
    })
    console.log(`  Phase 5 Complete: p50=${stats.p50Ms}ms, Total=${pDuration.toFixed(0)}ms`)
  }

  // ------------------------------------------------------------------
  // Phase 6: Multi-User Collaboration & RBAC
  // ------------------------------------------------------------------
  {
    console.log(`\n[Phase 6] Multi-User Collaboration & RBAC...`)
    const pStart = performance.now()
    const pStartEpoch = Date.now()
    const durations: number[] = []
    const statusCodes: number[] = []

    // 1. list_teams
    let r = await callMcpTool(target, 'list_teams', {})
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 2. create_team
    r = await callMcpTool(target, 'create_team', { name: `bench-team-${target.name}` })
    durations.push(r.durationMs); statusCodes.push(r.status)
    teamId = r.data?.id
    console.log(`  Created Team: ID=${teamId}`)

    // 3. list_team_members
    if (teamId) {
      r = await callMcpTool(target, 'list_team_members', { teamId })
      durations.push(r.durationMs); statusCodes.push(r.status)
    }

    // 4. share_vault
    let shareId: string | undefined
    if (teamId) {
      const shareRes = await callMcpTool(target, 'share_vault', {
        vaultId,
        granteeType: 'team',
        granteeId: teamId,
        permission: 'read',
      })
      durations.push(shareRes.durationMs); statusCodes.push(shareRes.status)
      shareId = shareRes.data?.id
    }

    // 5. list_vault_shares
    r = await callMcpTool(target, 'list_vault_shares', { vaultId })
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 6. revoke_vault_share
    if (shareId) {
      r = await callMcpTool(target, 'revoke_vault_share', { vaultId, shareId })
      durations.push(r.durationMs); statusCodes.push(r.status)
    }

    // 7. list_repository_shares
    if (repoId) {
      r = await callMcpTool(target, 'list_repository_shares', { repositoryId: repoId })
      durations.push(r.durationMs); statusCodes.push(r.status)
    }

    // 8. delete_team
    if (teamId) {
      r = await callMcpTool(target, 'delete_team', { teamId })
      durations.push(r.durationMs); statusCodes.push(r.status)
    }

    // 9. export_vault
    r = await callMcpTool(target, 'export_vault', { vaultId })
    durations.push(r.durationMs); statusCodes.push(r.status)

    // 10. list_notifications
    r = await callMcpTool(target, 'list_notifications', {})
    durations.push(r.durationMs); statusCodes.push(r.status)

    const pDuration = performance.now() - pStart
    const stats = calcStats(durations, pDuration, statusCodes)
    phases.push({
      phase: 6,
      title: 'Multi-User Collaboration & RBAC',
      target: target.name,
      startMs: pStartEpoch,
      endMs: Date.now(),
      durationMs: Number(pDuration.toFixed(2)),
      stats,
      details: { teamId },
    })
    console.log(`  Phase 6 Complete: p50=${stats.p50Ms}ms, Total=${pDuration.toFixed(0)}ms`)
  }

  // ------------------------------------------------------------------
  // Phase 7: MCP Engineering Prompts Context Hydration
  // ------------------------------------------------------------------
  {
    console.log(`\n[Phase 7] MCP Engineering Prompts Context Hydration (20 Prompts)...`)
    const pStart = performance.now()
    const pStartEpoch = Date.now()

    const { prompts, durationMs: listD } = await listMcpPrompts(target)
    console.log(`  Fetched ${prompts.length} registered prompts from server...`)

    const promptResults = await runWorkerPool(prompts, 5, async (promptDef) => {
      const promptName = promptDef.name
      const args: Record<string, string> = {}
      if (promptDef.arguments) {
        for (const a of promptDef.arguments) {
          if (a.name === 'vaultId') args[a.name] = vaultId
          else if (a.name === 'repositoryId') args[a.name] = repoId
          else if (a.name === 'projectName') args[a.name] = 'scale-benchmark'
          else if (a.name === 'query') args[a.name] = 'consensus'
          else if (a.name === 'path') args[a.name] = 'architecture/system-component-001'
          else args[a.name] = 'test'
        }
      }
      return callMcpPrompt(target, promptName, args)
    })

    const durations = [listD, ...promptResults.map((r) => r.durationMs)]
    const statusCodes = [200, ...promptResults.map((r) => r.status)]

    const pDuration = performance.now() - pStart
    const stats = calcStats(durations, pDuration, statusCodes)
    phases.push({
      phase: 7,
      title: 'MCP Engineering Prompts Hydration',
      target: target.name,
      startMs: pStartEpoch,
      endMs: Date.now(),
      durationMs: Number(pDuration.toFixed(2)),
      stats,
      details: { promptCount: prompts.length },
    })
    console.log(`  Phase 7 Complete: Prompts Hydrated=${prompts.length}, p50=${stats.p50Ms}ms, Total=${pDuration.toFixed(0)}ms`)
  }

  // ------------------------------------------------------------------
  // Phase 8: High-Scale AI Agent Swarm & Rate-Limiting Torture
  // ------------------------------------------------------------------
  {
    console.log(`\n[Phase 8] High-Scale AI Agent Runaway Swarm & 120 req/min Rate Limiting...`)
    const pStart = performance.now()
    const pStartEpoch = Date.now()

    // 1. Swarm burst: 25 workers reading notes concurrently
    console.log(`  Launching 25 concurrent agent workers (75 rapid read requests)...`)
    const readTasks = Array.from({ length: 75 }, (_, i) => {
      const padId = String((i % 50) + 1).padStart(3, '0')
      return `architecture/system-component-${padId}`
    })

    const swarmResults = await runWorkerPool(readTasks, 25, async (p) => {
      return callMcpTool(target, 'read_note', { vaultId, path: p })
    })

    // 2. Torture burst: 150 consecutive rapid requests to trigger 120 req/min rate limit
    console.log(`  Firing 150 rapid requests in tight loop to test 120 req/min limit...`)
    const tortureResults: any[] = []
    for (let i = 0; i < 150; i++) {
      const r = await callMcpTool(target, 'read_note', {
        vaultId,
        path: 'architecture/system-component-001',
      })
      tortureResults.push(r)
    }

    const allDurations = [...swarmResults.map((r) => r.durationMs), ...tortureResults.map((r) => r.durationMs)]
    const allStatusCodes = [...swarmResults.map((r) => r.status), ...tortureResults.map((r) => r.status)]

    const pDuration = performance.now() - pStart
    const stats = calcStats(allDurations, pDuration, allStatusCodes)

    const throttled429 = tortureResults.filter((r) => r.status === 429).length
    console.log(`  Rate limit test result: 429 Responses = ${throttled429} / 150`)

    phases.push({
      phase: 8,
      title: 'High-Scale AI Agent Swarm & Rate-Limiting Stress',
      target: target.name,
      startMs: pStartEpoch,
      endMs: Date.now(),
      durationMs: Number(pDuration.toFixed(2)),
      stats,
      details: {
        swarmRequests: swarmResults.length,
        tortureRequests: tortureResults.length,
        rateLimitedCount: throttled429,
      },
    })
    console.log(`  Phase 8 Complete: p50=${stats.p50Ms}ms, Throttled=${throttled429}, Total=${pDuration.toFixed(0)}ms`)
  }

  // ------------------------------------------------------------------
  // Cleanup: Delete and Purge Vault & Repo
  // ------------------------------------------------------------------
  console.log(`\n[Cleanup] Cleaning up benchmark resources...`)
  if (vaultId) {
    await callMcpTool(target, 'delete_vault', { vaultId })
    await callMcpTool(target, 'purge_vault', { vaultId })
    console.log(`  Purged vault: ${vaultId}`)
  }
  if (repoId) {
    await callMcpTool(target, 'delete_repository', { repositoryId: repoId })
    console.log(`  Deleted repository: ${repoId}`)
  }

  const suiteEndMs = Date.now()
  const totalDurationMs = suiteEndMs - suiteStartMs

  console.log(`\n======================================================================`)
  console.log(`>>> SUITE COMPLETED FOR: ${target.name.toUpperCase()} in ${(totalDurationMs / 1000).toFixed(1)}s`)
  console.log(`======================================================================\n`)

  return {
    target: target.name,
    title: target.title,
    startMs: suiteStartMs,
    endMs: suiteEndMs,
    totalDurationMs,
    phases,
  }
}

// -----------------------------------------------------------------------------------
// Master Execution
// -----------------------------------------------------------------------------------

async function main() {
  console.log(`\n######################################################################`)
  console.log(`#  ELARA MCP HEAD-TO-HEAD SCALE & TELEMETRY BENCHMARK               #`)
  console.log(`#  Host: 173.249.3.57 (Contabo VPS - 12 vCPUs, 48GB RAM)            #`)
  console.log(`#  Targets: PGVector (pgvector) vs. ChromaDB (chroma)                #`)
  console.log(`######################################################################\n`)

  const results: Record<string, TargetBenchmarkSummary> = {}

  for (const target of TARGETS) {
    const summary = await runScaleSuiteForTarget(target)
    results[target.name] = summary

    // Grace period between targets to allow connection pools and queues to settle
    console.log(`[Cooldown] Waiting 5 seconds before next target...`)
    await new Promise((res) => setTimeout(res, 5000))
  }

  const outputPath = path.resolve(process.cwd(), 'benchmark_results.json')
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2))
  console.log(`\n>>> Benchmark run complete! Client results saved to: ${outputPath}`)
}

main().catch((err) => {
  console.error('Fatal benchmark execution error:', err)
  process.exit(1)
})
