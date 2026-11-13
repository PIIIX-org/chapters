import { sql } from '../db/client.js'
import { runAssetStorage } from '../notes/asset-storage.js'
import { MaintenanceInProgressError } from '../notes/maintenance-lock.js'

let exitCode = 0
try {
  const [mode, vaultId, ...extra] = process.argv.slice(2)
  if (!['migrate', 'verify', 'rollback'].includes(mode ?? '') || extra.length || (vaultId && !/^[0-9a-f-]{36}$/i.test(vaultId))) {
    throw new Error('usage: pnpm asset-storage <migrate|verify|rollback> [vaultId]; stop all app writers and take a fresh verified backup first')
  }
  const reports = await runAssetStorage(mode as 'migrate' | 'verify' | 'rollback', vaultId)
  console.log(JSON.stringify(reports, null, 2))
  if (reports.some(r => r.conflicts.length > 0 || (mode === 'verify' && (r.state !== 'complete' || !r.ready || !r.baselineVerified)))) {
    console.error('Review the reported differing/preserved bytes. Do not start the old image when rollback has conflicts. No source or hidden attachment was overwritten.')
    exitCode = 2
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  exitCode = err instanceof MaintenanceInProgressError ? 2 : 1
} finally { await sql.end() }
process.exitCode = exitCode
