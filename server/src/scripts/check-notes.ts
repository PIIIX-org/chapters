/**
 * Note file integrity check, read-only (ADR-003 §7): compares each live
 * note's `.md` file with its row where the file projection has reached the
 * row's `seq`, and lists pending projections separately. Usage:
 *   pnpm check-notes [-- --vault <uuid>] [--wait-idle[=<seconds>]] [--fail-on-pending]
 * `--wait-idle` polls until no projection is pending (default 60 s), so a
 * check right after a restart or a burst of writes tests the projector, not
 * a race with it. `--fail-on-pending` makes any pending projection a failure
 * (CI's gate, #578: the projector must have run). Exits 1 when any note is
 * broken (or pending with `--fail-on-pending`), 2 on bad arguments.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { sql } from '../db/client.js'
import { checkNoteFiles, pendingProjectionList } from '../notes/integrity.js'

const USAGE = 'usage: check-notes [--vault <vault-id>] [--wait-idle[=<seconds>]] [--fail-on-pending]'
const args = process.argv.slice(2)
let vaultId: string | undefined
let waitSeconds = 0
let failOnPending = false
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!
  if (arg === '--') continue
  if (arg === '--vault' && args[i + 1]) vaultId = args[++i]
  else if (arg === '--wait-idle') waitSeconds = 60
  else if (arg.startsWith('--wait-idle=') && Number(arg.slice(12)) > 0) waitSeconds = Number(arg.slice(12))
  else if (arg === '--fail-on-pending') failOnPending = true
  else {
    console.error(USAGE)
    await sql.end()
    process.exit(2)
  }
}

const deadline = Date.now() + waitSeconds * 1000
while (waitSeconds > 0 && Date.now() < deadline && (await pendingProjectionList(vaultId)).length > 0) {
  await delay(500)
}

const { checked, problems, pending } = await checkNoteFiles(vaultId)
const broken = new Set(problems.map((p) => `${p.vaultId}/${p.path}`)).size
const report = [
  ...problems.map((p) => `BROKEN  ${p.vaultName} (${p.vaultId})  ${p.path}  ${p.problem}: ${p.detail}`),
  ...pending.map(
    (p) =>
      `PENDING ${p.vaultName} (${p.vaultId})  ${p.path}  ${p.projection} at ${p.appliedSeq} of ${p.targetSeq}${p.lastError ? `: ${p.lastError}` : ''}`,
  ),
  `checked ${checked} notes, ${broken} broken, ${pending.length} pending projection(s)`,
].join('\n')
// process.exit drops stdout still queued on a pipe (a long report under CI
// lost its tail and summary), so exit only once the report is flushed.
await new Promise<void>((resolve) => process.stdout.write(`${report}\n`, () => resolve()))
await sql.end()
process.exit(problems.length > 0 || (failOnPending && pending.length > 0) ? 1 : 0)
