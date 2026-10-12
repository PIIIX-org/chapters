/**
 * Note file integrity check: reads and parses every live note's file on disk
 * and lists the ones that cannot be opened. Run on the server
 * (`pnpm check-notes`, optionally `-- --vault <uuid>`); exits 1 when any note
 * is broken, so it can gate a deploy or run from cron.
 */
import { sql } from '../db/client.js'
import { checkNoteFiles } from '../notes/integrity.js'

const flag = process.argv.indexOf('--vault')
const vaultId = flag === -1 ? undefined : process.argv[flag + 1]
if (flag !== -1 && !vaultId) {
  console.error('usage: check-notes [--vault <vault-id>]')
  process.exit(2)
}

const { checked, problems } = await checkNoteFiles(vaultId)
for (const p of problems) {
  console.log(`BROKEN  ${p.vaultName} (${p.vaultId})  ${p.path}  ${p.problem}: ${p.detail}`)
}
console.log(`checked ${checked} notes, ${problems.length} broken`)
await sql.end()
process.exit(problems.length > 0 ? 1 : 0)
