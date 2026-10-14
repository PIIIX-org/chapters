// What does a SIGKILL in the middle of note writes leave behind?
//
// The write path has no transaction spanning DB and disk:
//   createNote  (notes/store.ts:208-258): INSERT row -> atomicWrite(file)
//               -> regen index.md -> links -> recordRevision
//   updateNote  (notes/store.ts:313-345): UPDATE row -> atomicWrite(file)
//               -> links -> recordRevision
//   edit_note   goes through the relay first (sync/crdt-write.ts:35-80),
//               whose debounced store writes note + .crdt bin
//               (sync/collab-server.ts:176-190)
//   atomicWrite = writeFile(`${file}.tmp`) + rename, no fsync (store.ts:92-97)
// so a kill between steps can leave: row != file, row without file, file
// without row, missing revision, stale .crdt bin, orphan .tmp.
//
// Method: one control round without a kill (pure concurrency), then rounds
// that fire N edit_note + M create_note calls concurrently and SIGKILL the
// app `killAfterMs` after dispatch, while one collab client has a dirty doc
// (typed, acked, inside the 2 s store debounce) and another client typed and
// closed its tab. After restart every note is compared: file on disk (parsed
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
const KILL_AFTER = (process.env.LAB_CRASH_KILL_AFTER_MS ?? '0,25,75,150,300,600').split(',').map(Number)
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
  startMs: number
  endMs: number | null
  answer: Answer
  httpStatus: number
  error?: string
  outcome?: Outcome
  revGap?: boolean
}

interface RoundReport {
  round: number
  killAfterMs: number | null
  crash?: Record<string, unknown>
  ops: { total: number; acked: number; appError: number; noAnswer: number; ackedAfterKillIssued: number }
  outcomes: Record<string, number>
  outcomesNoAnswer: Record<string, number>
  ackedLost: { path: string; kind: OpKind; outcome: Outcome }[]
  divergentNotes: { path: string; issue: string }[]
  revisionGaps: string[]
  crdtMismatch: string[]
  tmpFiles: { file: string; bytes: number }[]
  unparseable: { path: string; error: string }[]
  orphanFiles: string[]
  collab: Record<string, unknown>
  checkNotes: { code: number; broken: string[]; tail: string }
  appErrors: string[]
}

interface Analysis {
  disk: Map<string, DiskNote>
  rowByPath: Map<string, DbNote>
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
    else if (f.bodySha !== r.body_sha) divergent.push({ path: r.path, issue: `file body != row body (file ${f.bodyLen} chars, row ${r.body_len})` })
    if (r.last_rev_sha !== r.body_sha) revisionGaps.push(r.path)
  }
  for (const c of dump.crdt) {
    const f = disk.get(c.path)
    if (c.decodeError) crdtMismatch.push(`${c.path}: undecodable`)
    else if (f?.parseOk && c.bodySha !== f.bodySha) crdtMismatch.push(`${c.path}: crdt ${c.bodyLen} chars vs file ${f.bodyLen}`)
  }
  // Files the DB does not know (excluding generated directory index.md files).
  const orphanFiles = dump.notes
    .filter((n) => !rowByPath.has(n.path) && !(n.path === 'index' || n.path.endsWith('/index')))
    .map((n) => n.path)
  return { disk, rowByPath, divergent, revisionGaps, crdtMismatch, unparseable, orphanFiles }
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
    const current = new Map<string, string>() // path -> sha of the body we believe is current
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
    const plan: (number | null)[] = [null, ...KILL_AFTER]
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
      for (let i = 0; i < N_EDITS; i++) {
        const path = basePaths[i]!
        const body = genBody(BODY_BYTES, round * 1000 + i, `round ${round} edit ${i}`)
        const op: Op = { kind: 'edit', path, newSha: sha(body), oldSha: current.get(path) ?? null, startMs: 0, endMs: null, answer: 'no-answer', httpStatus: 0 }
        ops.push(op)
        promises.push(
          editMcp.call('edit_note', { vaultId: vault.id, path, body }, 120_000).then((r) => {
            op.endMs = performance.now() - t0
            op.httpStatus = r.httpStatus
            op.answer = r.ok ? 'acked' : r.httpStatus === 200 ? 'app-error' : 'no-answer'
            if (!r.ok) op.error = r.text.slice(0, 300)
          }),
        )
      }
      for (let j = 0; j < N_CREATES; j++) {
        const path = `cw/r${round}-new-${String(j).padStart(2, '0')}`
        const body = genBody(BODY_BYTES, round * 1000 + 500 + j, `round ${round} create ${j}`)
        const op: Op = { kind: 'create', path, newSha: sha(body), oldSha: null, startMs: 0, endMs: null, answer: 'no-answer', httpStatus: 0 }
        ops.push(op)
        promises.push(
          createMcp.call('create_note', { vaultId: vault.id, path, body }, 120_000).then((r) => {
            op.endMs = performance.now() - t0
            op.httpStatus = r.httpStatus
            op.answer = r.ok ? 'acked' : r.httpStatus === 200 ? 'app-error' : 'no-answer'
            if (!r.ok) op.error = r.text.slice(0, 300)
          }),
        )
      }

      let crash: Record<string, unknown> | undefined
      let killIssuedMs: number | null = null
      if (killAfterMs !== null) {
        if (killAfterMs > 0) await Bun.sleep(killAfterMs)
        killIssuedMs = performance.now() - t0
        crash = { killIssuedMs: Math.round(killIssuedMs), ...(await crashApp(ctx.baseUrl)) }
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
      }
      const ackedLost = ops
        .filter((o) => o.answer === 'acked' && o.outcome !== 'consistent-new')
        .map((o) => ({ path: o.path, kind: o.kind, outcome: o.outcome! }))
      const cn = await checkNotes(vault.id)
      const broken = cn.stdout.split('\n').filter((l) => l.startsWith('BROKEN'))
      const stayBody = dump.notes.find((n) => n.path === livePaths[0])?.body ?? ''
      const leaveBody = dump.notes.find((n) => n.path === livePaths[1])?.body ?? ''
      const logs = await appLogsSince(startedIso, 2000)
      const appErrors = [...new Set(logs.split('\n').filter((l) => /error|ENOENT|rejected|unhandled/i.test(l)).map((l) => l.replace(/^\S+\s+\|\s+/, '').slice(0, 240)))].slice(0, 30)

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
        outcomesNoAnswer: tally(ops.filter((o) => o.answer !== 'acked').map((o) => `${o.kind}:${o.answer}:${o.outcome}`)),
        ackedLost,
        divergentNotes: a.divergent,
        revisionGaps: a.revisionGaps,
        crdtMismatch: a.crdtMismatch,
        tmpFiles: dump.tmp.map((t) => ({ file: t.file, bytes: t.bytes })),
        unparseable: a.unparseable,
        orphanFiles: a.orphanFiles,
        collab: {
          stayAcked,
          staysResynced: staysSynced,
          stayMarkerOnDisk: count(stayBody, stayMarker),
          leaverConnected,
          leaveAcked,
          leaveMarkerOnDisk: count(leaveBody, leaveMarker),
        },
        checkNotes: { code: cn.code, broken, tail: cn.stdout.split('\n').slice(-2).join(' | ') },
        appErrors,
      }
      rounds.push(rep)
      ctx.log(`round ${round}: ${JSON.stringify({ ops: rep.ops, outcomes: rep.outcomes, divergent: a.divergent.length, tmp: dump.tmp.length, revGaps: a.revisionGaps.length })}`)

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
        name: `${label}: file = row for every live note`,
        expected: '0 divergent notes',
        actual: a.divergent.length === 0 ? '0' : `${a.divergent.length}: ${JSON.stringify(a.divergent.slice(0, 5))}`,
        ok: a.divergent.length === 0,
        severity: 'high',
      })
      checks.push({
        name: `${label}: latest revision = current body`,
        expected: '0 notes whose newest note_revisions row differs from notes.body',
        actual: a.revisionGaps.length === 0 ? '0' : `${a.revisionGaps.length}: ${a.revisionGaps.slice(0, 5).join(', ')}`,
        ok: a.revisionGaps.length === 0,
        severity: 'medium',
      })
      checks.push({
        name: `${label}: no orphan .tmp files`,
        expected: '0',
        actual: dump.tmp.length === 0 ? '0' : `${dump.tmp.length}: ${dump.tmp.slice(0, 5).map((t) => t.file).join(', ')}`,
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
        name: `${label}: .crdt bin = file for every collab-loaded note`,
        expected: '0 mismatches (a mismatch is rebuilt with new Yjs items on next load)',
        actual: a.crdtMismatch.length === 0 ? '0' : `${a.crdtMismatch.length}: ${a.crdtMismatch.slice(0, 5).join('; ')}`,
        ok: a.crdtMismatch.length === 0,
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
      }
      if (killAfterMs === null) {
        checks.push({
          name: 'control: concurrent create_note/edit_note all succeed without a crash',
          expected: `${ops.length} acked`,
          actual: `${rep.ops.acked} acked, ${rep.ops.appError} app errors${rep.ops.appError ? `: ${[...new Set(ops.filter((o) => o.answer === 'app-error').map((o) => o.error?.slice(0, 160)))].join(' | ')}` : ''}`,
          ok: rep.ops.acked === ops.length,
          severity: 'high',
        })
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

    const crashRounds = rounds.filter((r) => r.killAfterMs !== null)
    const sum = (f: (r: RoundReport) => number) => crashRounds.reduce((n, r) => n + f(r), 0)
    const summary =
      `${plan.length} rounds (1 control + ${crashRounds.length} SIGKILL at +${KILL_AFTER.join('/')} ms) of ${N_EDITS} edit_note + ${N_CREATES} create_note (${BODY_BYTES} B bodies) each, with a dirty collab doc. ` +
      `Over the crash rounds: ${sum((r) => r.ops.acked)} acked / ${sum((r) => r.ops.noAnswer)} unanswered / ${sum((r) => r.ops.appError)} app errors; ` +
      `acked writes lost ${sum((r) => r.ackedLost.length)}; file!=row ${sum((r) => r.divergentNotes.length)} (cumulative per-round counts); ` +
      `revision gaps ${sum((r) => r.revisionGaps.length)}; orphan .tmp ${sum((r) => r.tmpFiles.length)}; unparseable ${sum((r) => r.unparseable.length)}; .crdt!=file ${sum((r) => r.crdtMismatch.length)}. ` +
      `Final state: ${fin.divergent.length} divergent, ${fin.revisionGaps.length} revision gaps, ${finalDump.tmp.length} .tmp, ${fin.orphanFiles.length} files without row. ` +
      `Control round: ${rounds[0]?.ops.acked}/${rounds[0]?.ops.total} acked.`
    return {
      summary,
      checks,
      data: {
        vaultId: vault.id,
        config: { N_EDITS, N_CREATES, BODY_BYTES, KILL_AFTER },
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
      },
    }
  },
}
export default test
