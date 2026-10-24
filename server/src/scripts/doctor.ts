/**
 * The doctor (ADR-003 S6, #495): compares each note's file, row, revision,
 * CRDT state, FTS vector, embedding, links and projections, and each
 * repository file's blocks (#413), and reports every mismatch
 * (notes/doctor.ts). Usage:
 *   pnpm doctor [-- --vault <uuid>] [--repository <uuid>] [--repair] [--report [<file>]]
 * `--vault` checks one vault and no repository files; `--repository` checks
 * that repository's files. Read-only unless `--repair`, which re-raises
 * derived state (file and index projections, link rows, embedding and
 * extraction jobs) and folds a stuck collab tail as
 * boot does; it never invents or overwrites note content.
 * `--report` prints the JSON report instead of text; `--report <file>` writes
 * it to a new file (an existing file or symlink is refused). `--repair` holds
 * the shared instance maintenance lock like every writing CLI. Exit code, by
 * the report's `status` (`INFO` lines and `PENDING` work never count): 0 no
 * problem, 3 only problems `--repair` re-raises (run it, then the doctor
 * again), 1 at least one problem that needs a person; 2 on bad arguments or
 * while maintenance holds the lock.
 */
import { open, type FileHandle } from 'node:fs/promises'
import { sql } from '../db/client.js'
import { runDoctor } from '../notes/doctor.js'
import { holdSharedLockOrExit } from '../notes/maintenance-lock.js'

const USAGE = 'usage: doctor [--vault <vault-id>] [--repository <repository-id>] [--repair] [--report [<file>]]'
const args = process.argv.slice(2).filter((arg) => arg !== '--')
let vaultId: string | undefined
let repositoryId: string | undefined
let repair = false
let json = false
let reportPath: string | undefined
let bad = false
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!
  if (arg === '--vault' && args[i + 1] && !args[i + 1]!.startsWith('--')) vaultId = args[++i]
  else if (arg === '--repository' && args[i + 1] && !args[i + 1]!.startsWith('--')) repositoryId = args[++i]
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

// `--repair` writes, so it holds the shared instance lock like every writing CLI (exit 2 while store-export-legacy
// or rows-from-files runs). Taken before the report file is created, so a refusal leaves no empty file behind.
const instanceLock = repair ? await holdSharedLockOrExit() : null

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

const report = await runDoctor({ vaultId, repositoryId, repair })
await instanceLock?.release()
const summary =
  `checked ${report.checked.notes} notes, ${report.checked.files} files, ${report.checked.bins} .crdt bins, ` +
  `${report.checked.crdtRows} note_crdt rows, ${report.checked.repositoryFiles} repository files: ${report.problems.length} problem(s)` +
  (repair ? `, ${report.problems.filter((p) => p.repaired).length} repair(s) queued` : '') +
  `, ${report.pending.length} pending, ${report.info.length} info` +
  (report.status === 'repairable' ? `\nevery problem is repairable: ${repair ? 'run the doctor again once the projector is idle' : 'run with --repair'}` : '')
/** A vault, or for a repository file's line (#413) its repository. */
const where = (p: { vaultId: string; vaultName: string; repositoryId?: string; repositoryName?: string }) =>
  p.repositoryId ? `repository ${p.repositoryName} (${p.repositoryId})` : `${p.vaultName} (${p.vaultId})`
let out: string
if (json) out = `${JSON.stringify(report, null, 2)}\n`
else {
  out = [
    ...report.problems.map(
      (p) => `PROBLEM ${p.class}  ${where(p)}  ${p.path}: ${p.detail}${p.repaired ? '  [repair queued]' : p.repairable ? '  [--repair]' : ''}`,
    ),
    ...report.pending.map((p) => `PENDING ${p.kind}  ${where(p)}  ${p.path}: ${p.detail}`),
    ...report.info.map((p) => `INFO ${p.kind}  ${p.vaultName} (${p.vaultId})  ${p.path}: ${p.detail}`),
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
process.exit({ ok: 0, repairable: 3, broken: 1 }[report.status])
