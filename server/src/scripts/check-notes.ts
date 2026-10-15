/**
 * Note file integrity check: reads and parses every live note's file on disk
 * and lists the ones that are missing, cannot be opened, or differ from their
 * database row (frontmatter or body). Run on the server (`pnpm check-notes`,
 * optionally `-- --vault <uuid>`); exits 1 when any note is broken, so it can
 * gate a deploy or run from cron. CI runs it after the server test suite. On a
 * running server an edit in flight can show as a mismatch for a moment; re-run
 * before acting on a single one.
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
const broken = new Set(problems.map((p) => `${p.vaultId}/${p.path}`)).size
const report = [
  ...problems.map((p) => `BROKEN  ${p.vaultName} (${p.vaultId})  ${p.path}  ${p.problem}: ${p.detail}`),
  `checked ${checked} notes, ${broken} broken`,
].join('\n')
// process.exit drops stdout still queued on a pipe (a long report under CI
// lost its tail and summary), so exit only once the report is flushed.
await new Promise<void>((resolve) => process.stdout.write(`${report}\n`, () => resolve()))
await sql.end()
process.exit(problems.length > 0 ? 1 : 0)
