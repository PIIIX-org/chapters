/**
 * ADR-003 store migration (§8). Usage:
 *   pnpm migrate-store --dry-run [--report <file>] [--vault <uuid>]
 *
 * Only `--dry-run` exists in this release: it reads every note row, `.md`
 * file and `.crdt` bin in one read-only transaction and reports what the S2a
 * and S2b backfills would do (classes, the Q5 conflict list, files that change
 * bytes, timings). It runs no migrations and writes nothing but the report
 * file named by `--report` (without it, the report goes to stdout), so it is
 * safe against a production copy. The backfill itself ships with S2a.
 */
import { writeFile } from 'node:fs/promises'
import { sql } from '../db/client.js'
import { planStoreMigration } from '../notes/migrate-store.js'

const USAGE = 'usage: migrate-store --dry-run [--report <file>] [--vault <vault-id>]'
const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const reportPath = option('--report')
const vaultId = option('--vault')
const known = new Set(['--dry-run', '--report', '--vault', reportPath, vaultId])
if (
  !args.includes('--dry-run') ||
  args.some((arg) => !known.has(arg)) ||
  (args.includes('--report') && !reportPath) ||
  (args.includes('--vault') && !vaultId)
) {
  console.error(
    args.includes('--dry-run') ? USAGE : `${USAGE}\nonly --dry-run is available: the backfill ships with ADR-003 S2a`,
  )
  await sql.end()
  process.exit(2)
}

const report = await planStoreMigration({ vaultId })
const json = `${JSON.stringify(report, null, 2)}\n`
const c = report.counts
const summary =
  `dry run: ${c.notes} notes (${c.liveNotes} live, ${c.trashedNotes} trashed); ` +
  `file consistent ${c.file.consistent}, differs ${c.file.differs} (conflicts, file wins), ` +
  `missing ${c.file.missing}, unparseable ${c.file.unparseable}, not serializeNote form ${c.notSerializeNoteForm}; ` +
  `revision gap ${c.revision.gap}, none ${c.revision.none}; ` +
  `crdt row ${c.crdt['matches-row']}, file ${c.crdt['matches-file']}, revision ${c.crdt['matches-revision']}, ` +
  `mismatch ${c.crdt.mismatch}, undecodable ${c.crdt.undecodable}, missing ${c.crdt.missing}; ` +
  `files without row ${c.filesWithoutRow}, trash files without row ${c.trashFilesWithoutRow}, ` +
  `bins without note ${c.binsWithoutNote}; files that change bytes ${c.filesThatChangeBytes}; ` +
  `${report.timingsMs.total} ms`
if (reportPath) {
  await writeFile(reportPath, json, { flag: 'wx' })
  console.log(`${summary}\nreport: ${reportPath}`)
} else {
  await new Promise<void>((resolve) => process.stdout.write(json, () => resolve()))
  console.error(summary)
}
await sql.end()
