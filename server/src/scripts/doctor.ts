/**
 * The doctor (ADR-003 S6, #495): compares each note's file, row, revision,
 * CRDT state, FTS vector, embedding, links and projections, and reports
 * every mismatch (notes/doctor.ts). Usage:
 *   pnpm doctor [-- --vault <uuid>] [--repair] [--report [<file>]]
 * Read-only unless `--repair`, which only re-raises derived state (file and
 * index projections, link rows, embedding jobs) and never edits note content.
 * `--report` prints the JSON report instead of text; `--report <file>` writes
 * it to a new file (an existing file or symlink is refused). `--repair` holds
 * the shared instance maintenance lock like every writing CLI. Exits 1 when
 * it found a problem, 2 on bad arguments or while maintenance holds the lock.
 */
import { open, type FileHandle } from 'node:fs/promises'
import { sql } from '../db/client.js'
import { runDoctor } from '../notes/doctor.js'
import { holdSharedLockOrExit } from '../notes/maintenance-lock.js'

const USAGE = 'usage: doctor [--vault <vault-id>] [--repair] [--report [<file>]]'
const args = process.argv.slice(2).filter((arg) => arg !== '--')
let vaultId: string | undefined
let repair = false
let json = false
let reportPath: string | undefined
let bad = false
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!
  if (arg === '--vault' && args[i + 1] && !args[i + 1]!.startsWith('--')) vaultId = args[++i]
  else if (arg === '--repair') repair = true
  else if (arg === '--report') {
    json = true
    if (args[i + 1] && !args[i + 1]!.startsWith('--')) reportPath = args[++i]
  } else bad = true
}
if (bad) {
  console.error(USAGE)
  await sql.end()
  process.exit(2)
}

let file: FileHandle | undefined
if (reportPath) {
  try {
    file = await open(reportPath, 'wx')
  } catch (err) {
    const { code, message } = err as NodeJS.ErrnoException
    console.error(code === 'EEXIST' ? `--report ${reportPath} already exists (or is a symlink); name a new file` : `cannot create --report ${reportPath}: ${message}`)
    await sql.end()
    process.exit(2)
  }
}

// `--repair` writes, so it holds the shared instance lock like every writing CLI (exit 2 while store-export-legacy or rows-from-files runs).
const instanceLock = repair ? await holdSharedLockOrExit() : null
const report = await runDoctor({ vaultId, repair })
await instanceLock?.release()
const summary =
  `checked ${report.checked.notes} notes, ${report.checked.files} files, ${report.checked.bins} .crdt bins, ` +
  `${report.checked.crdtRows} note_crdt rows: ${report.problems.length} problem(s)` +
  (repair ? `, ${report.problems.filter((p) => p.repaired).length} repair(s) queued` : '') +
  `, ${report.pending.length} pending`
let out: string
if (json) out = `${JSON.stringify(report, null, 2)}\n`
else {
  out = [
    ...report.problems.map(
      (p) => `PROBLEM ${p.class}  ${p.vaultName} (${p.vaultId})  ${p.path}: ${p.detail}${p.repaired ? '  [repair queued]' : p.repairable ? '  [--repair]' : ''}`,
    ),
    ...report.pending.map((p) => `PENDING ${p.kind}  ${p.vaultName} (${p.vaultId})  ${p.path}: ${p.detail}`),
    summary,
  ].join('\n')
  out += '\n'
}
if (file) {
  await file.writeFile(out)
  await file.close()
  console.log(`${summary}\nreport: ${reportPath}`)
} else {
  // process.exit drops stdout still queued on a pipe, so exit only once it is flushed.
  await new Promise<void>((resolve) => process.stdout.write(out, () => resolve()))
}
await sql.end()
process.exit(report.ok ? 0 : 1)
