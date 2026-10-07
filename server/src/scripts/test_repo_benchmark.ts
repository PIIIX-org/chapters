import { performance } from 'node:perf_hooks'
import { TARGETS, callMcpTool } from './run-live-scale-suite.js'

async function runRepoBench() {
  console.log("=== RUNNING REPOSITORY INGESTION & TREE-SITTER BENCHMARK ===")

  for (const target of TARGETS) {
    console.log(`\nTarget: ${target.name} (${target.title})`)
    const t0 = performance.now()
    
    // 1. Connect Repo
    const repoName = `spoon-knife-bench-${target.name}`
    console.log(`  Connecting https://github.com/octocat/Spoon-Knife.git...`)
    const connRes = await callMcpTool(target, 'connect_repository', {
      name: repoName,
      ingestionMethod: 'git',
      gitUrl: 'https://github.com/octocat/Spoon-Knife.git',
    })
    
    if (connRes.status !== 200 || !connRes.data?.id) {
      console.error(`  Failed to connect repo: status=${connRes.status}, error=${connRes.error}`, connRes.data)
      continue
    }
    
    const repoId = connRes.data.id
    console.log(`  Repo connected: ID=${repoId} in ${connRes.durationMs.toFixed(1)}ms`)
    
    // 2. Poll status until synced
    let isSynced = false
    let syncDurationMs = 0
    const pollStart = performance.now()
    while (performance.now() - pollStart < 30000) {
      await new Promise((r) => setTimeout(r, 1000))
      const statusRes = await callMcpTool(target, 'repository_status', { repositoryId: repoId })
      const status = statusRes.data?.syncStatus
      process.stdout.write(`  Status: ${status} (${((performance.now() - pollStart)/1000).toFixed(1)}s)\n`)
      if (status === 'synced' || status === 'ready') {
        isSynced = true
        syncDurationMs = performance.now() - pollStart
        break
      }
      if (status === 'error') {
        console.error(`  Sync error:`, statusRes.data?.lastSyncError)
        break
      }
    }
    
    // 3. Browse repo
    const browseRes = await callMcpTool(target, 'browse_repository', { repositoryId: repoId })
    const files = Array.isArray(browseRes.data) ? browseRes.data : browseRes.data?.files ?? []
    console.log(`  Browse repo: Found ${files.length} files in ${browseRes.durationMs.toFixed(1)}ms`)
    
    // 4. Read file & AST outline
    const readRes = await callMcpTool(target, 'read_file', { repositoryId: repoId, path: 'index.html' })
    console.log(`  Read index.html: Status=${readRes.status} in ${readRes.durationMs.toFixed(1)}ms`)
    
    // 5. Find symbols
    const symRes = await callMcpTool(target, 'find_symbols', { repositoryId: repoId, query: 'octocat' })
    console.log(`  Find symbols ('octocat'): in ${symRes.durationMs.toFixed(1)}ms`)
    
    // Cleanup
    await callMcpTool(target, 'delete_repository', { repositoryId: repoId })
    console.log(`  Deleted repo: ${repoId}`)
  }
}

runRepoBench().catch(console.error)
