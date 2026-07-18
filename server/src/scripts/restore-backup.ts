/**
 * Restores a full-instance backup zip onto a fresh instance.
 * Usage: pnpm restore-backup <path-to-backup.zip>
 *
 * Deliberately a CLI, not an HTTP endpoint — restoring over a live
 * instance is not a button (spec 7's implementation plan). Refuses to
 * run against anything but a genuinely empty instance; no override.
 */
import { readFile } from 'node:fs/promises'
import { runMigrations } from '../db/migrate.js'
import { sql } from '../db/client.js'
import { isInstanceEmpty, restoreBackup } from '../export/restore.js'

const path = process.argv[2]
if (!path) {
  console.error('Usage: pnpm restore-backup <path-to-backup.zip>')
  process.exit(1)
}

await runMigrations()

if (!(await isInstanceEmpty())) {
  console.error(
    'Refusing to restore: this instance already has users. ' +
      'Restore only runs against a fresh, empty instance.',
  )
  await sql.end()
  process.exit(1)
}

const buffer = await readFile(path)
const result = await restoreBackup(buffer)

console.log('Restore complete:')
console.log(`  users: ${result.users}`)
console.log(`  teams: ${result.teams}`)
console.log(`  team memberships: ${result.teamMemberships}`)
console.log(`  vaults: ${result.vaults}`)
console.log(`  vault shares: ${result.vaultShares}`)
console.log(`  MCP connections (metadata only, tokens unusable): ${result.mcpConnections}`)
console.log(`  security events: ${result.securityEvents}`)
console.log(`  notifications: ${result.notifications}`)
console.log(`  notes imported: ${result.notesImported}`)
if (result.notesSkipped.length > 0) {
  console.log(`  notes skipped (${result.notesSkipped.length}):`)
  for (const skip of result.notesSkipped) console.log(`    - ${skip}`)
}

await sql.end()
