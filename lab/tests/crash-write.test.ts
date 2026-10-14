// What does a SIGKILL in the middle of note writes leave behind?
//
// The write path has no transaction spanning DB and disk:
//   createNote  (notes/store.ts:208-258): INSERT row -> atomicWrite(file)
//               -> regen index.md -> links -> recordRevision
//   updateNote  (notes/store.ts:313-345): UPDATE row -> atomicWrite(file)
//               -> links -> recordRevision
//   edit_note   goes through the relay first (sync/crdt-write.ts:35-80):
//               DirectConnection.transact, disconnect (Hocuspocus 4 stores
//               on disconnect: updateNote as actor 'collab' + .crdt bin,
//               sync/collab-server.ts:176-190), then updateNote as actor 'mcp'
//   atomicWrite = writeFile(`${file}.tmp`) + rename, no fsync (store.ts:92-97)
// so a kill between steps can leave: row != file, row without file, file
// without row, missing revision, stale .crdt bin, orphan .tmp.
//
// Method: a control round without a kill (pure concurrency; its completion
// times place the kills), then rounds that fire N edit_note + M create_note
// concurrently and SIGKILL the app at spread points of that completion
// curve, while one collab client has a dirty doc (typed, acked, inside the
// 2 s store debounce) and another client typed and closed its tab. After the
// restart every note touched in the round is compared: file on disk (parsed
// in-container with the app's parseNote), notes row, latest revision, .crdt
// bin; .tmp files are listed; `check-notes` (server/src/scripts) is run.
import type { Check, LabContext, LabTest } from '../lib/context.ts'
import { CollabClient } from '../lib/collab.ts'
import { stringField } from '../lib/mcp.ts'
import { RestSession } from '../lib/rest.ts'
import {
  appLogsSince,
  checkNotes,
  count,
  crashApp,
  dbNotes,
  dumpVault,
  genBody,
  sha,
  type DbNote,
  type DiskNote,
  type VaultDump,
} from '../lib/datapath.ts'

const N_EDITS = Number(process.env.LAB_CRASH_EDITS ?? 24)
const N_CREATES = Number(process.env.LAB_CRASH_CREATES ?? 16)
const BODY_BYTES = Number(process.env.LAB_CRASH_BODY_BYTES ?? 40_000)
/** Fixed kill offsets (ms after dispatch); default = quantiles of the control round's completion times. */
const KILL_AFTER_FIXED = process.env.LAB_CRASH_KILL_AFTER_MS?.split(',').map(Number)
const KILL_QUANTILES = [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1]
const SETTLE_MS = 3500

type OpKind = 'edit' | 'create'
type Answer = 'acked' | 'app-error' | 'no-answer'
type Outcome =
  | 'consistent-new'
  | 'consistent-old'
  | 'absent'
  | 'row-new/file-old'
  | 'row-old/file-new'
  | 'row-only (no file)'
  | 'file-only (no row)'
  | 'unparseable'
  | 'other'

interface Op {
  kind: OpKind
  path: string
  newSha: string
  oldSha: string | null
  endMs: number | null
  answer: Answer
  httpStatus: number
  error?: string
  outcome?: Outcome
  /** Newest revision != row body (the write is not in the audit trail). */
  revGap?: boolean
  /** .crdt bin relative to this op: has the new body, the old one, none, or something else. */
  crdt?: 'new' | 'old' | 'none' | 'other'
  revActor?: string | null
}

interface RoundReport {
  round: number
  killAfterMs: number | null
  crash?: Record<string, unknown>
  ops: { total: number; acked: number; appError: number; noAnswer: number; ackedAfterKillIssued: number }
  outcomes: Record<string, number>
  outcomesUnacked: Record<string, number>
  crdtVsOp: Record<string, number>
  ackedLost: { path: string; kind: OpKind; outcome: Outcome }[]
  /** Issues on notes this round touched. */
  touched: { divergent: { path: string; issue: string }[]; revisionGaps: string[]; crdtMismatch: string[]; unparseable: { path: string; error: string }[] }
  /** Vault-wide totals (includes what earlier rounds left behind). */
  vaultTotals: { divergent: number; revisionGaps: number; crdtMismatch: number; tmp: number; orphanFiles: number }
  tmpFiles: { file: string; bytes: number }[]
  collab: Record<string, unknown>
  checkNotes: { code: number; broken: string[]; tail: string }
  opList: Op[]
}

interface Analysis {
  disk: Map<string, DiskNote>
  rowByPath: Map<string, DbNote>
  crdtByPath: Map<string, string | undefined>
  divergent: { path: string; issue: string }[]
  revisionGaps: string[]
  crdtMismatch: string[]
  unparseable: { path: string; error: string }[]
  orphanFiles: string[]
}

function analyse(dump: VaultDump, rows: DbNote[]): Analysis {
  const disk = new Map(dump.notes.map((n) => [n.path, n]))
  const live = rows.filter((r) => !r.deleted)
  const rowByPath = new Map(live.map((r) => [r.path, r]))
  const divergent: { path: string; issue: string }[] = []
  const revisionGaps: string[] = []
  const crdtMismatch: string[] = []
  const unparseable: { path: string; error: string }[] = []
  for (const r of live) {
    const f = disk.get(r.path)
    if (!f) divergent.push({ path: r.path, issue: 'row without file' })
    else if (!f.parseOk) unparseable.push({ path: r.path, error: f.parseError ?? '' })
    else if (f.bodySha !== r.body_sha) divergent.push({ path: r.path, issue: 'file body != row body' })
    if (r.last_rev_sha !== r.body_sha) revisionGaps.push(r.path)
  }
  for (const c of dump.crdt) {
    const f = disk.get(c.path)
    if (c.decodeError) crdtMismatch.push(c.path)
    else if (f?.parseOk && c.bodySha !== f.bodySha) crdtMismatch.push(c.path)
  }
  // Files the DB does not know (excluding generated directory index.md files).
  const orphanFiles = dump.notes
    .filter((n) => !rowByPath.has(n.path) && !(n.path === 'index' || n.path.endsWith('/index')))
    .map((n) => n.path)
  const crdtByPath = new Map(dump.crdt.map((c) => [c.path, c.bodySha]))
  return { disk, rowByPath, crdtByPath, divergent, revisionGaps, crdtMismatch, unparseable, orphanFiles }
}

function classify(op: Op, a: Analysis): Outcome {
  const f = a.disk.get(op.path)
  const r = a.rowByPath.get(op.path)
  if (f && !f.parseOk) return 'unparseable'
  const fs = f?.bodySha ?? null
  const rs = r?.body_sha ?? null
  if (op.kind === 'create') {
    if (!f && !r) return 'absent'
    if (r && !f) return 'row-only (no file)'
    if (f && !r) return 'file-only (no row)'
    if (fs === op.newSha && rs === op.newSha) return 'consistent-new'
    return 'other'
  }
  if (fs === op.newSha && rs === op.newSha) return 'consistent-new'
  if (fs === op.oldSha && rs === op.oldSha) return 'consistent-old'
  if (rs === op.newSha && fs === op.oldSha) return 'row-new/file-old'
  if (rs === op.oldSha && fs === op.newSha) return 'row-old/file-new'
  if (r && !f) return 'row-only (no file)'
  return 'other'
}

const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {})

const test: LabTest = {
  name: 'crash-write',
  description: 'SIGKILL during concurrent edit_note/create_note + dirty collab docs; compare file vs row vs revision vs .crdt per note.',
  async run(ctx: LabContext) {
    const checks: Check[] = []
    const startedIso = new Date().toISOString()
    const vault = await ctx.createVault('admin', ctx.uniq('crash'))
    const editTok = await ctx.mintToken('admin', ctx.uniq('crash-edit'))
    const createTok = await ctx.mintToken('admin', ctx.uniq('crash-create'))
    const editMcp = ctx.mcp(editTok.token, 'crash-edit')
    const createMcp = ctx.mcp(createTok.token, 'crash-create')
    const admin = ctx.env.users.admin
    const sess = await RestSession.login(ctx.baseUrl, admin.email, admin.password)

    // Base notes the edit ops rewrite every round.
    const current = new Map<string, string>() // path -> sha of the body on disk (what read_note serves)
    const basePaths: string[] = []
    for (let i = 0; i < N_EDITS; i++) {
      const path = `cw/base-${String(i).padStart(2, '0')}`
      const body = genBody(BODY_BYTES, 1000 + i, `base ${i}`)
      await editMcp.must('create_note', { vaultId: vault.id, path, body })
      current.set(path, sha(body))
      basePaths.push(path)
    }
    // Collab notes: one client stays connected, one types and leaves before each kill.
    const livePaths = ['cw/live-stays', 'cw/live-leaves']
    for (const p of livePaths) await editMcp.must('create_note', { vaultId: vault.id, path: p, body: `live note ${p}\n` })
    const stays = new CollabClient(ctx.baseUrl, `${vault.id}/${livePaths[0]}`, sess)
    if (!(await stays.connect())) throw new Error(`collab client could not connect: ${stays.status} ${stays.authFailed}`)

    const baseline = analyse(await dumpVault(vault.id), await dbNotes(ctx, vault.id))
    checks.push({
      name: 'baseline: every note consistent before any crash',
      expected: 'file = row = latest revision for all notes',
      actual: `${baseline.divergent.length} divergent, ${baseline.revisionGaps.length} revision gaps, ${baseline.unparseable.length} unparseable`,
      ok: baseline.divergent.length + baseline.revisionGaps.length + baseline.unparseable.length === 0 ? true : null,
      severity: 'info',
    })

    const rounds: RoundReport[] = []
    const plan: (number | null)[] = [null]
    let killLatency = 200
    for (let round = 0; round < plan.length; round++) {
      const killAfterMs = plan[round]!
      ctx.log(`round ${round}: kill after ${killAfterMs ?? 'none (control)'}`)

      // Dirty collab docs: acked by the relay, still inside the store debounce.
      const stayMarker = `@CW-STAY-r${round}@`
      stays.type(`\n${stayMarker}`)
      const stayAcked = await stays.waitAcked()
      const leaver = new CollabClient(ctx.baseUrl, `${vault.id}/${livePaths[1]}`, sess)
      const leaverConnected = await leaver.connect()
      const leaveMarker = `@CW-LEAVE-r${round}@`
      leaver.type(`\n${leaveMarker}`)
      const leaveAcked = await leaver.waitAcked()
      leaver.destroy()

      // Concurrent writes.
      const ops: Op[] = []
      const t0 = performance.now()
      const promises: Promise<void>[] = []
      const fire = (op: Op, client: typeof editMcp, tool: string, args: Record<string, unknown>) => {
        ops.push(op)
        promises.push(
          client.call(tool, args, 120_000).then((r) => {
            op.endMs = Math.round(performance.now() - t0)
            op.httpStatus = r.httpStatus
            op.answer = r.ok ? 'acked' : r.httpStatus === 200 ? 'app-error' : 'no-answer'
            if (!r.ok) op.error = r.text.slice(0, 300)
          }),
        )
      }
      for (let i = 0; i < N_EDITS; i++) {
        const path = basePaths[i]!
        const body = genBody(BODY_BYTES, round * 1000 + i, `round ${round} edit ${i}`)
        fire({ kind: 'edit', path, newSha: sha(body), oldSha: current.get(path) ?? null, endMs: null, answer: 'no-answer', httpStatus: 0 }, editMcp, 'edit_note', { vaultId: vault.id, path, body })
      }
      for (let j = 0; j < N_CREATES; j++) {
        const path = `cw/r${round}-new-${String(j).padStart(2, '0')}`
        const body = genBody(BODY_BYTES, round * 1000 + 500 + j, `round ${round} create ${j}`)
        fire({ kind: 'create', path, newSha: sha(body), oldSha: null, endMs: null, answer: 'no-answer', httpStatus: 0 }, createMcp, 'create_note', { vaultId: vault.id, path, body })
      }

      let crash: Record<string, unknown> | undefined
      let killIssuedMs: number | null = null
      if (killAfterMs !== null) {
        const wait = killAfterMs - killLatency
        if (wait > 0) await Bun.sleep(wait)
        killIssuedMs = performance.now() - t0
        const c = await crashApp(ctx.baseUrl)
        killLatency = Math.max(50, Math.min(600, c.killMs))
        crash = { killIssuedMs: Math.round(killIssuedMs), killMs: Math.round(c.killMs), healthyMs: Math.round(c.healthyMs), killCode: c.killCode, startCode: c.startCode }
      }
      await Promise.all(promises)
      const staysSynced = await stays.waitSynced(60_000)
      await stays.waitAcked()
      await Bun.sleep(SETTLE_MS)

      const dump = await dumpVault(vault.id, livePaths)
      const rows = await dbNotes(ctx, vault.id)
      const a = analyse(dump, rows)
      for (const op of ops) {
        op.outcome = classify(op, a)
        const r = a.rowByPath.get(op.path)
        op.revGap = r ? r.last_rev_sha !== r.body_sha : false
        op.revActor = r?.last_rev_actor ?? null
        const c = a.crdtByPath.get(op.path)
        op.crdt = !a.crdtByPath.has(op.path) ? 'none' : c === op.newSha ? 'new' : c === op.oldSha ? 'old' : 'other'
      }
      const touchedPaths = new Set([...ops.map((o) => o.path), ...livePaths])
      const ackedLost = ops
        .filter((o) => o.answer === 'acked' && o.outcome !== 'consistent-new')
        .map((o) => ({ path: o.path, kind: o.kind, outcome: o.outcome! }))
      const cn = await checkNotes(vault.id)
      const broken = cn.stdout.split('\n').filter((l) => l.startsWith('BROKEN'))
      const stayBody = dump.notes.find((n) => n.path === livePaths[0])?.body ?? ''
      const leaveBody = dump.notes.find((n) => n.path === livePaths[1])?.body ?? ''
      const touched = {
        divergent: a.divergent.filter((d) => touchedPaths.has(d.path)),
        revisionGaps: a.revisionGaps.filter((p) => touchedPaths.has(p)),
        crdtMismatch: a.crdtMismatch.filter((p) => touchedPaths.has(p)),
        unparseable: a.unparseable.filter((u) => touchedPaths.has(u.path)),
      }

      const rep: RoundReport = {
        round,
        killAfterMs,
        crash,
        ops: {
          total: ops.length,
          acked: ops.filter((o) => o.answer === 'acked').length,
          appError: ops.filter((o) => o.answer === 'app-error').length,
          noAnswer: ops.filter((o) => o.answer === 'no-answer').length,
          ackedAfterKillIssued: killIssuedMs === null ? 0 : ops.filter((o) => o.answer === 'acked' && (o.endMs ?? 0) > killIssuedMs!).length,
        },
        outcomes: tally(ops.map((o) => `${o.kind}:${o.outcome}`)),
        outcomesUnacked: tally(ops.filter((o) => o.answer !== 'acked').map((o) => `${o.kind}:${o.answer}:${o.outcome}${o.revGap ? '+revgap' : ''}`)),
        crdtVsOp: tally(ops.filter((o) => o.kind === 'edit').map((o) => `${o.outcome} / crdt=${o.crdt}`)),
        ackedLost,
        touched,
        vaultTotals: { divergent: a.divergent.length, revisionGaps: a.revisionGaps.length, crdtMismatch: a.crdtMismatch.length, tmp: dump.tmp.length, orphanFiles: a.orphanFiles.length },
        tmpFiles: dump.tmp.map((t) => ({ file: t.file, bytes: t.bytes })),
        collab: {
          stayAcked,
          staysResynced: staysSynced,
          stayMarkerOnDisk: count(stayBody, stayMarker),
          leaverConnected,
          leaveAcked,
          leaveMarkerOnDisk: count(leaveBody, leaveMarker),
        },
        checkNotes: { code: cn.code, broken, tail: cn.stdout.split('\n').slice(-1).join('') },
        opList: ops,
      }
      rounds.push(rep)
      ctx.log(`round ${round}: ${JSON.stringify({ ops: rep.ops, outcomes: rep.outcomes, touched: { d: touched.divergent.length, g: touched.revisionGaps.length, c: touched.crdtMismatch.length }, tmp: dump.tmp.length })}`)

      // The next round's "old" is what is on disk now (what read_note serves).
      for (const p of basePaths) {
        const f = a.disk.get(p)
        if (f?.bodySha) current.set(p, f.bodySha)
      }

      const label = killAfterMs === null ? 'control (no kill)' : `kill +${killAfterMs} ms`
      checks.push({
        name: `${label}: acknowledged writes survive`,
        expected: 'every acked edit/create is on disk and in the row',
        actual: ackedLost.length === 0 ? `all ${rep.ops.acked} acked writes intact` : `${ackedLost.length} lost/diverged: ${JSON.stringify(ackedLost.slice(0, 5))}`,
        ok: ackedLost.length === 0,
        severity: 'critical',
      })
      checks.push({
        name: `${label}: file = row for every note written in the round`,
        expected: '0 divergent notes',
        actual: touched.divergent.length === 0 ? '0' : `${touched.divergent.length}: ${JSON.stringify(touched.divergent.slice(0, 5))}`,
        ok: touched.divergent.length === 0,
        severity: 'high',
      })
      checks.push({
        name: `${label}: latest revision = current body for every note written in the round`,
        expected: '0 notes whose newest note_revisions row differs from notes.body',
        actual: touched.revisionGaps.length === 0 ? '0' : `${touched.revisionGaps.length}: ${touched.revisionGaps.slice(0, 5).join(', ')}`,
        ok: touched.revisionGaps.length === 0,
        severity: 'medium',
      })
      checks.push({
        name: `${label}: no orphan .tmp files in the vault`,
        expected: '0',
        actual: dump.tmp.length === 0 ? '0' : `${dump.tmp.length}: ${dump.tmp.slice(0, 5).map((t) => `${t.file} (${t.bytes} B)`).join(', ')}`,
        ok: dump.tmp.length === 0,
        severity: 'low',
      })
      checks.push({
        name: `${label}: check-notes clean`,
        expected: 'exit 0, 0 broken',
        actual: `exit ${cn.code}; ${broken.length} broken${cn.stderr ? `; stderr ${cn.stderr.slice(0, 200)}` : ''}`,
        ok: cn.code === 0 ? true : broken.length > 0 ? false : null,
        severity: 'high',
      })
      checks.push({
        name: `${label}: .crdt bin = file for every note written in the round`,
        expected: '0 mismatches (a mismatch is rebuilt with new Yjs items on the next load)',
        actual: touched.crdtMismatch.length === 0 ? '0' : `${touched.crdtMismatch.length}: ${JSON.stringify(rep.crdtVsOp)}`,
        ok: touched.crdtMismatch.length === 0,
        severity: 'medium',
      })
      if (killAfterMs !== null) {
        checks.push({
          name: `${label}: dirty collab doc (client stays) survives without duplication`,
          expected: 'marker exactly once on disk',
          actual: String(rep.collab.stayMarkerOnDisk),
          ok: rep.collab.stayMarkerOnDisk === 1,
          severity: 'high',
        })
        checks.push({
          name: `${label}: acked collab edit of a closed tab survives SIGKILL`,
          expected: 'marker on disk (relay acked it before the kill)',
          actual: `acked ${leaveAcked}; on disk ${rep.collab.leaveMarkerOnDisk}`,
          ok: rep.collab.leaveMarkerOnDisk === 1,
          severity: 'high',
        })
      } else {
        const appErrors = [...new Set(ops.filter((o) => o.answer === 'app-error').map((o) => o.error?.replace(/[0-9a-f-]{36}/g, '<vault>').slice(0, 200)))]
        const failedButCreated = ops.filter((o) => o.kind === 'create' && o.answer === 'app-error' && o.outcome === 'consistent-new')
        checks.push({
          name: 'control: concurrent create_note/edit_note all succeed without a crash',
          expected: `${ops.length} acked`,
          actual: `${rep.ops.acked} acked, ${rep.ops.appError} app errors${appErrors.length ? `: ${appErrors.join(' | ')}` : ''}`,
          ok: rep.ops.acked === ops.length,
          severity: 'high',
        })
        checks.push({
          name: 'control: a create_note that returns an error did not create the note',
          expected: '0 notes created by calls that answered isError',
          actual: `${failedButCreated.length} of ${ops.filter((o) => o.kind === 'create' && o.answer === 'app-error').length} failed creates exist on disk and in the DB (revision gap: ${failedButCreated.filter((o) => o.revGap).length})`,
          ok: failedButCreated.length === 0,
          severity: 'high',
        })
        // writeThroughCollab (crdt-write.ts:75-79) disconnects its DirectConnection
        // before the attributed updateNote; Hocuspocus 4 stores on that disconnect
        // (DirectConnection unloadImmediately defaults to true), so the relay's
        // unattributed 'collab' write may land first and the MCP revision is deduped.
        const ackedEdits = ops.filter((o) => o.kind === 'edit' && o.answer === 'acked')
        const actors = tally(ackedEdits.map((o) => o.revActor ?? 'none'))
        rep.collab.editRevisionActors = actors
        checks.push({
          name: 'control: edit_note revisions are attributed to the MCP connection',
          expected: `newest revision actor_type = mcp for all ${ackedEdits.length} acked edits`,
          actual: JSON.stringify(actors),
          ok: (actors.mcp ?? 0) === ackedEdits.length,
          severity: 'medium',
        })
        // Place the kills along the control round's completion curve.
        const ends = ops.map((o) => o.endMs ?? 0).sort((x, y) => x - y)
        const fixed = KILL_AFTER_FIXED ?? KILL_QUANTILES.map((q) => ends[Math.min(ends.length - 1, Math.floor(q * (ends.length - 1)))]!)
        plan.push(...fixed)
        ctx.log(`control completion ms: min ${ends[0]} p50 ${ends[Math.floor(ends.length / 2)]} max ${ends.at(-1)} -> kills at ${fixed.join(',')}`)
      }
    }
    stays.destroy()

    // What a reader sees for notes left divergent (read_note serves the file; search/embeddings use the row).
    const finalDump = await dumpVault(vault.id)
    const finalRows = await dbNotes(ctx, vault.id)
    const fin = analyse(finalDump, finalRows)
    const probes: Record<string, unknown>[] = []
    for (const d of fin.divergent.slice(0, 10)) {
      const r = await editMcp.call('read_note', { vaultId: vault.id, path: d.path })
      const body = stringField(r.json, 'body')
      probes.push({
        path: d.path,
        issue: d.issue,
        readNoteServes: body === undefined ? `error: ${r.text.slice(0, 120)}` : sha(body) === fin.disk.get(d.path)?.bodySha ? 'file' : sha(body) === fin.rowByPath.get(d.path)?.body_sha ? 'row' : 'neither',
      })
    }
    const logs = await appLogsSince(startedIso, 3000)
    const appErrors = [...new Set(logs.split('\n').filter((l) => /error|ENOENT|rejected|unhandled/i.test(l)).map((l) => l.replace(/^\S+\s+\|\s+\S+\s+/, '').replace(/[0-9a-f-]{36}/g, '<id>').slice(0, 240)))].slice(0, 30)

    const crashRounds = rounds.filter((r) => r.killAfterMs !== null)
    const unacked = crashRounds.flatMap((r) => r.opList.filter((o) => o.answer !== 'acked'))
    const sum = (f: (r: RoundReport) => number) => crashRounds.reduce((n, r) => n + f(r), 0)
    const unackedOutcomes = tally(unacked.map((o) => `${o.kind}:${o.outcome}`))
    const summary =
      `${rounds.length} rounds (1 control + ${crashRounds.length} SIGKILL at +${crashRounds.map((r) => r.killAfterMs).join('/')} ms) of ${N_EDITS} edit_note + ${N_CREATES} create_note (${BODY_BYTES} B bodies) each, with a dirty collab doc. ` +
      `Control: ${rounds[0]?.ops.acked}/${rounds[0]?.ops.total} acked. ` +
      `Crash rounds: ${sum((r) => r.ops.acked)} acked (lost: ${sum((r) => r.ackedLost.length)}), ${unacked.length} unanswered -> ${JSON.stringify(unackedOutcomes)}; ` +
      `per-round touched issues: file!=row ${sum((r) => r.touched.divergent.length)}, revision gaps ${sum((r) => r.touched.revisionGaps.length)}, .crdt!=file ${sum((r) => r.touched.crdtMismatch.length)}; ` +
      `closed-tab collab edits lost ${crashRounds.filter((r) => r.collab.leaveMarkerOnDisk === 0).length}/${crashRounds.length}. ` +
      `Final vault: ${fin.divergent.length} file!=row, ${fin.revisionGaps.length} revision gaps, ${finalDump.tmp.length} orphan .tmp, ${fin.orphanFiles.length} files without row, check-notes broken ${rounds.at(-1)?.checkNotes.broken.length}.`
    return {
      summary,
      checks,
      data: {
        vaultId: vault.id,
        config: { N_EDITS, N_CREATES, BODY_BYTES, kills: crashRounds.map((r) => r.killAfterMs) },
        unackedOutcomes,
        rounds,
        final: {
          divergent: fin.divergent,
          revisionGaps: fin.revisionGaps,
          crdtMismatch: fin.crdtMismatch,
          tmp: finalDump.tmp,
          orphanFiles: fin.orphanFiles,
          unparseable: fin.unparseable,
          probes,
        },
        appErrors,
      },
    }
  },
}
export default test
