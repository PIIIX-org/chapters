// How do big notes behave on the read/write/history paths, and where are
// the limits?
//
// - note_history (mcp/server.ts:798-811) returns listRevisions()
//   (notes/store.ts:566-577): every revision with its full body, no limit,
//   JSON.stringify'd once by wrap() (mcp/server.ts:139) and again by the MCP
//   transport. Response size ~ note size x revisions.
// - edit_note / create_note return the whole row (body included).
// - REST and MCP bodies are capped by Fastify's default 1 MiB bodyLimit (no
//   bodyLimit is configured in app.ts), but the collab relay is a `ws`
//   WebSocketServer with the default 100 MiB maxPayload
//   (sync/collab-server.ts:199) and updateNote has no size check.
//
// Method: notes of 100/500/900 KiB, 5 edits each, read_note + note_history
// sizes/latencies with app-container memory sampled (cgroup + docker stats)
// during note_history; then grow the 900 KiB note's history until
// note_history passes 50 MB / 30 s / restarts the app, then parallel
// note_history fan-out; then push >1 MiB bodies through a Hocuspocus client.
import type { Check, LabContext, LabTest } from '../lib/context.ts'
import { CollabClient, Y, type CollabEvent } from '../lib/collab.ts'
import { stringField } from '../lib/mcp.ts'
import { RestSession } from '../lib/rest.ts'
import {
  MB,
  appLogsSince,
  appState,
  dbNotes,
  fmtMB,
  genBody,
  rawMcp,
  startHealthSampler,
  startMemSampler,
  type AppState,
  type HealthReport,
  type MemReport,
  type RawCall,
} from '../lib/datapath.ts'

const KiB = 1024
const SIZES = (process.env.LAB_BIG_SIZES_KIB ?? '100,500,900').split(',').map((s) => Number(s) * KiB)
const EDITS = 5
const CHECKPOINTS = (process.env.LAB_BIG_CHECKPOINTS ?? '15,30,45,60,90,120,160,220,300').split(',').map(Number)
const FANOUT = (process.env.LAB_BIG_FANOUT ?? '2,4,8').split(',').map(Number)
const COLLAB_MIB = (process.env.LAB_BIG_COLLAB_MIB ?? '1.5,5,20').split(',').map(Number)
const OVER_WS_MIB = Number(process.env.LAB_BIG_OVER_WS_MIB ?? 110)
const SIZE_LIMIT = 50 * 1000 * 1000
const TIME_LIMIT_MS = 30_000

interface Row {
  phase: string
  noteKiB: number
  op: string
  revs: number | null
  parallel?: number
  httpStatus: number
  ok: boolean
  bytes: number
  ms: number
  ttfbMs: number
  mem?: MemReport
  health?: HealthReport
  restarted?: boolean
  error?: string
}

interface CollabRec {
  mib: number
  target: number
  acked: boolean
  ackMs: number
  storedInDb: boolean
  dbLen: number
  storedMs: number
  readNoteBytes: number
  readNoteMs: number
  readLen: number
  peakCurrent: number | null
  peakAnon: number | null
  health: HealthReport
  restarted: boolean
  closes: CollabEvent[]
  status: string
}

interface FanoutRec {
  parallel: number
  ok: number
  wallMs: number
  maxMs: number
  totalBytes: number
  peakCurrent: number | null
  peakAnon: number | null
  dockerStatsPeak: number | null
  restarted: boolean
  oomKilled: boolean
  exitCode: number
}

const restartedBetween = (a: AppState, b: AppState) => a.startedAt !== b.startedAt || a.restartCount !== b.restartCount

const test: LabTest = {
  name: 'big-notes',
  description: '100/500/900 KiB notes: read/edit/history size, latency, app memory; note_history limits; >1 MiB via collab vs REST/MCP.',
  async run(ctx: LabContext) {
    const checks: Check[] = []
    const rows: Row[] = []
    const startedIso = new Date().toISOString()
    const vault = await ctx.createVault('admin', ctx.uniq('big'))
    const tok = await ctx.mintToken('admin', ctx.uniq('big'))
    const call = (tool: string, args: Record<string, unknown>, opts?: { timeoutMs?: number; parse?: boolean }) =>
      rawMcp(ctx.baseUrl, tok.token, tool, { vaultId: vault.id, ...args }, opts)

    /** One call with memory + health sampling and restart detection. */
    async function measured(phase: string, noteKiB: number, op: string, revs: number | null, fn: () => Promise<RawCall>): Promise<Row> {
      const before = await appState()
      const mem = await startMemSampler()
      const health = startHealthSampler(ctx.baseUrl)
      const r = await fn()
      const [m, h] = await Promise.all([mem.stop(), health.stop()])
      const after = await appState()
      const restarted = restartedBetween(before, after) || r.httpStatus === 0
      if (restarted) await ctx.docker.waitHealthy(ctx.baseUrl)
      const row: Row = { phase, noteKiB, op, revs, httpStatus: r.httpStatus, ok: r.ok, bytes: r.bytes, ms: Math.round(r.ms), ttfbMs: Math.round(r.ttfbMs), mem: m, health: h, restarted, error: r.ok ? undefined : (r.error ?? r.textHead.slice(0, 300)) }
      rows.push(row)
      ctx.log(`${phase} ${op} ${noteKiB}KiB revs=${revs}: HTTP ${r.httpStatus} ${fmtMB(r.bytes)} ${Math.round(r.ms)} ms mem ${fmtMB(m.peakCurrent)} anon ${fmtMB(m.peakAnon)} restarted=${restarted}`)
      return row
    }

    function plain(phase: string, noteKiB: number, op: string, revs: number | null, r: RawCall): Row {
      const row: Row = { phase, noteKiB, op, revs, httpStatus: r.httpStatus, ok: r.ok, bytes: r.bytes, ms: Math.round(r.ms), ttfbMs: Math.round(r.ttfbMs), error: r.ok ? undefined : (r.error ?? r.textHead.slice(0, 300)) }
      rows.push(row)
      return row
    }

    async function revCount(path: string): Promise<number> {
      return (await dbNotes(ctx, vault.id)).find((n) => n.path === path)?.revs ?? -1
    }

    // ---------------------------------------------------------------- 1. sizes
    const notePath = (size: number) => `big/n${size / KiB}k`
    for (const size of SIZES) {
      const path = notePath(size)
      const kib = size / KiB
      const c = await call('create_note', { path, body: genBody(size, size) })
      plain('sizes', kib, 'create_note', 1, c)
      checks.push({ name: `create ${kib} KiB note`, expected: 'ok', actual: c.ok ? `ok ${Math.round(c.ms)} ms` : `HTTP ${c.httpStatus} ${c.textHead.slice(0, 120)}`, ok: c.ok ? true : null, severity: 'high' })
      if (!c.ok) continue
      plain('sizes', kib, 'read_note', 1, await call('read_note', { path }))
      for (let e = 1; e <= EDITS; e++) {
        plain('sizes', kib, 'edit_note', e + 1, await call('edit_note', { path, body: genBody(size, size + e, `edit ${e}`) }))
      }
      plain('sizes', kib, 'read_note', EDITS + 1, await call('read_note', { path }))
      const revs = await revCount(path)
      const h = await measured('sizes', kib, 'note_history', revs, () => call('note_history', { path }, { timeoutMs: 600_000 }))
      checks.push({
        name: `note_history of a ${kib} KiB note with ${revs} revisions`,
        expected: `< 50 MB and < 30 s`,
        actual: `${fmtMB(h.bytes)}, ${h.ms} ms, peak app memory ${fmtMB(h.mem?.peakCurrent)}`,
        ok: h.ok && h.bytes < SIZE_LIMIT && h.ms < TIME_LIMIT_MS,
        severity: 'medium',
      })
    }

    // ---------------------------------------------------------------- 2. grow the biggest note's history
    const bigSize = Math.max(...SIZES)
    const bigPath = notePath(bigSize)
    const bigKiB = bigSize / KiB
    let revs = await revCount(bigPath)
    let edits = 0
    const editMs: number[] = []
    const thresholds: Record<string, { revs: number; bytes: number; ms: number } | null> = { over50MB: null, over30s: null, restartOrFailure: null }
    for (const cp of CHECKPOINTS) {
      if (revs < 0) break
      while (revs < cp) {
        const r = await call('edit_note', { path: bigPath, body: genBody(bigSize, 10_000 + edits, `grow ${edits}`) })
        edits++
        if (!r.ok) {
          plain('grow', bigKiB, 'edit_note', revs, r)
          break
        }
        editMs.push(r.ms)
        revs++
      }
      revs = await revCount(bigPath)
      const h = await measured('grow', bigKiB, 'note_history', revs, () => call('note_history', { path: bigPath }, { timeoutMs: 900_000 }))
      if (!thresholds.over50MB && h.bytes > SIZE_LIMIT) thresholds.over50MB = { revs, bytes: h.bytes, ms: h.ms }
      if (!thresholds.over30s && h.ms > TIME_LIMIT_MS) thresholds.over30s = { revs, bytes: h.bytes, ms: h.ms }
      if (h.restarted || !h.ok) {
        thresholds.restartOrFailure = { revs, bytes: h.bytes, ms: h.ms }
        break
      }
    }
    const sortedEdit = [...editMs].sort((a, b) => a - b)
    const histRows = rows.filter((r) => r.op === 'note_history' && r.ok && r.revs)
    const bytesPerRevKiB = histRows.map((r) => r.bytes / (r.revs! * r.noteKiB * KiB))
    checks.push({
      name: 'note_history response stays under 50 MB',
      expected: 'bounded (paged) history',
      actual: thresholds.over50MB
        ? `exceeded at ${thresholds.over50MB.revs} revisions of a ${bigKiB} KiB note: ${fmtMB(thresholds.over50MB.bytes)}`
        : `not exceeded up to ${revs} revisions`,
      ok: thresholds.over50MB === null,
      severity: 'high',
    })
    checks.push({
      name: 'note_history answers within 30 s',
      expected: '< 30 s',
      actual: thresholds.over30s ? `took ${thresholds.over30s.ms} ms at ${thresholds.over30s.revs} revisions (${fmtMB(thresholds.over30s.bytes)})` : `under 30 s up to ${revs} revisions`,
      ok: thresholds.over30s === null,
      severity: 'medium',
    })
    checks.push({
      name: 'single note_history call never restarts the app',
      expected: 'no restart / no failure',
      actual: thresholds.restartOrFailure ? `restart/failure at ${thresholds.restartOrFailure.revs} revisions` : `none up to ${revs} revisions`,
      ok: thresholds.restartOrFailure === null,
      severity: 'critical',
    })

    // ---------------------------------------------------------------- 3. parallel fan-out on the grown note
    const fanout: FanoutRec[] = []
    if (!thresholds.restartOrFailure) {
      for (const k of FANOUT) {
        const before = await appState()
        const mem = await startMemSampler()
        const health = startHealthSampler(ctx.baseUrl)
        const t0 = performance.now()
        const results = await Promise.all(Array.from({ length: k }, () => call('note_history', { path: bigPath }, { timeoutMs: 900_000 })))
        const wall = performance.now() - t0
        const [m, h] = await Promise.all([mem.stop(), health.stop()])
        const after = await appState()
        const restarted = restartedBetween(before, after) || results.some((r) => r.httpStatus === 0)
        if (restarted) await ctx.docker.waitHealthy(ctx.baseUrl)
        const okCount = results.filter((r) => r.ok).length
        rows.push({ phase: 'fanout', noteKiB: bigKiB, op: 'note_history', revs, parallel: k, httpStatus: results[0]?.httpStatus ?? 0, ok: okCount === k, bytes: results.reduce((n, r) => n + r.bytes, 0), ms: Math.round(wall), ttfbMs: Math.round(Math.max(...results.map((r) => r.ttfbMs))), mem: m, health: h, restarted, error: okCount === k ? undefined : results.find((r) => !r.ok)?.error ?? results.find((r) => !r.ok)?.textHead.slice(0, 200) })
        fanout.push({ parallel: k, ok: okCount, wallMs: Math.round(wall), maxMs: Math.round(Math.max(...results.map((r) => r.ms))), totalBytes: results.reduce((n, r) => n + r.bytes, 0), peakCurrent: m.peakCurrent, peakAnon: m.peakAnon, dockerStatsPeak: m.dockerStatsPeak, restarted, oomKilled: after.oomKilled, exitCode: after.exitCode })
        ctx.log(`fanout ${k}: ok ${okCount}/${k} wall ${Math.round(wall)} ms peak ${fmtMB(m.peakCurrent)} restarted ${restarted}`)
        if (restarted || okCount < k) break
      }
      const broke = fanout.find((f) => f.restarted || f.ok < f.parallel)
      checks.push({
        name: 'parallel note_history on a big note does not restart the app',
        expected: `no restart for ${FANOUT.join('/')} parallel calls`,
        actual: broke ? `broke at ${broke.parallel} parallel calls (${JSON.stringify(broke)})` : `survived up to ${FANOUT.at(-1)} parallel calls, peak ${fmtMB(Math.max(...fanout.map((f) => f.peakCurrent ?? 0)))}`,
        ok: !broke,
        severity: 'critical',
      })
    }

    // ---------------------------------------------------------------- 4. > 1 MiB: REST/MCP vs collab
    const cPath = 'big/collab'
    await call('create_note', { path: cPath, body: 'small start\n' })
    const over = genBody(Math.round(1.5 * MB), 77)
    const rest = await ctx.rest('admin').request('PUT', `/api/vaults/${vault.id}/notes/${cPath}`, { body: over })
    const mcpOver = await call('edit_note', { path: cPath, body: over })
    checks.push({
      name: 'REST PUT rejects a 1.5 MiB body',
      expected: 'HTTP 413',
      actual: `HTTP ${rest.status}`,
      ok: rest.status === 413 ? true : null,
      severity: 'info',
    })
    checks.push({
      name: 'MCP edit_note rejects a 1.5 MiB body',
      expected: 'HTTP 413',
      actual: `HTTP ${mcpOver.httpStatus} ${mcpOver.textHead.slice(0, 100)}`,
      ok: mcpOver.httpStatus === 413 ? true : null,
      severity: 'info',
    })

    const admin = ctx.env.users.admin
    const sess = await RestSession.login(ctx.baseUrl, admin.email, admin.password)
    const client = new CollabClient(ctx.baseUrl, `${vault.id}/${cPath}`, sess)
    const collab: CollabRec[] = []
    let collabHistory: { bytes: number; ms: number; revs: number | null; peak: number | null | undefined } | null = null
    const connected = await client.connect()
    if (connected) {
      for (const mib of [...COLLAB_MIB, OVER_WS_MIB]) {
        const target = Math.round(mib * MB)
        const overLimit = mib >= 100
        const body = genBody(target, 900 + mib)
        const before = await appState()
        const mem = await startMemSampler()
        const health = startHealthSampler(ctx.baseUrl)
        const t0 = performance.now()
        client.ydoc.transact(() => {
          const t = client.ydoc.getText('body')
          t.delete(0, t.length)
          t.insert(0, body)
        })
        const acked = await client.waitAcked(overLimit ? 60_000 : 180_000)
        const ackMs = performance.now() - t0
        // Wait for the debounced store to land in the notes row.
        let dbLen = -1
        const tStore = performance.now()
        while (performance.now() - tStore < (overLimit ? 20_000 : 180_000)) {
          dbLen = (await dbNotes(ctx, vault.id)).find((n) => n.path === cPath)?.body_len ?? -1
          if (dbLen === target) break
          await Bun.sleep(1000)
        }
        const storedMs = performance.now() - t0
        const [m, h] = await Promise.all([mem.stop(), health.stop()])
        const after = await appState()
        const restarted = restartedBetween(before, after)
        if (restarted) await ctx.docker.waitHealthy(ctx.baseUrl)
        const read = await call('read_note', { path: cPath }, { parse: true })
        const readLen = stringField(read.json, 'body')?.length ?? -1
        const closes = client.events.filter((e) => e.kind === 'close').slice(-3)
        const rec: CollabRec = { mib, target, acked, ackMs: Math.round(ackMs), storedInDb: dbLen === target, dbLen, storedMs: Math.round(storedMs), readNoteBytes: read.bytes, readNoteMs: Math.round(read.ms), readLen, peakCurrent: m.peakCurrent, peakAnon: m.peakAnon, health: h, restarted, closes, status: client.status }
        collab.push(rec)
        ctx.log(`collab ${mib} MiB: ${JSON.stringify({ ...rec, closes: closes.length })}`)
        if (overLimit || !client.synced || client.status !== 'connected') {
          // An over-limit frame closes the socket and the provider would resend it on every
          // reconnect; drop this doc and continue with a fresh one.
          client.destroy()
          client.ydoc = new Y.Doc()
          await client.connect()
        }
      }
      const accepted = collab.filter((c) => c.storedInDb && c.mib > 1)
      checks.push({
        name: 'one size limit on every write path',
        expected: 'collab refuses bodies REST/MCP refuse (> 1 MiB)',
        actual: accepted.length ? `collab stored ${accepted.map((c) => `${c.mib} MiB`).join(', ')} while REST/MCP answer 413 for 1.5 MiB` : 'collab refused > 1 MiB too',
        ok: accepted.length === 0,
        severity: 'medium',
      })
      const overRec = collab.find((c) => c.mib === OVER_WS_MIB)
      checks.push({
        name: `${OVER_WS_MIB} MiB collab update is refused without harming the app`,
        expected: 'socket closed (ws maxPayload 100 MiB), app keeps running',
        actual: overRec ? `stored ${overRec.storedInDb}; restarted ${overRec.restarted}; closes ${JSON.stringify(overRec.closes)}` : 'not run',
        ok: overRec ? !overRec.restarted && !overRec.storedInDb : null,
        severity: 'high',
      })
      const stall = collab.filter((c) => c.health.maxMs > 5000)
      checks.push({
        name: 'storing a big collab body does not stall the server',
        expected: '/health answers within 5 s throughout',
        actual: stall.length ? stall.map((c) => `${c.mib} MiB: /health max ${c.health.maxMs} ms`).join('; ') : 'max /health latency under 5 s',
        ok: stall.length === 0,
        severity: 'medium',
      })
      // Round trip: an agent reads the collab-grown note and appends one line.
      if (accepted.length > 0) {
        const cur = await call('read_note', { path: cPath }, { parse: true })
        const curBody = stringField(cur.json, 'body') ?? ''
        const rt = await call('edit_note', { path: cPath, body: `${curBody}\nappended by agent` })
        checks.push({
          name: 'an agent can append to a note that collab grew past 1 MiB',
          expected: 'edit_note ok',
          actual: `body ${fmtMB(curBody.length)}: HTTP ${rt.httpStatus} ${rt.ok ? 'ok' : rt.textHead.slice(0, 80)}`,
          ok: rt.ok,
          severity: 'medium',
        })
      }
      const hist = await measured('collab', 0, 'note_history', await revCount(cPath), () => call('note_history', { path: cPath }, { timeoutMs: 900_000 }))
      collabHistory = { bytes: hist.bytes, ms: hist.ms, revs: hist.revs, peak: hist.mem?.peakCurrent }
    } else {
      checks.push({ name: 'collab client connects', expected: 'synced', actual: `${client.status} ${client.authFailed}`, ok: null, severity: 'high' })
    }
    client.destroy()

    // ---------------------------------------------------------------- 5. cleanup
    // Each 900 KiB edit queued two in-memory embedding jobs (embedding-queue.ts
    // has no dedupe). Delete the notes and restart so later tests do not run
    // behind that backlog.
    for (const size of SIZES) await call('delete_note', { path: notePath(size) })
    await call('delete_note', { path: cPath })
    const logs = await appLogsSince(startedIso, 3000)
    const notable = [...new Set(logs.split('\n').filter((l) => /heap|out of memory|Invalid string length|RangeError|FATAL|embedding (permanently )?failed|ECONNRESET/i.test(l)).map((l) => l.slice(0, 300)))].slice(0, 30)
    const restartFinal = await ctx.docker.app.restart(ctx.baseUrl)

    const histSummary = rows
      .filter((r) => r.op === 'note_history')
      .map((r) => `${r.noteKiB}KiB x${r.revs}${r.parallel ? ` x${r.parallel}par` : ''}: ${fmtMB(r.bytes)} ${r.ms}ms peak ${fmtMB(r.mem?.peakCurrent)}${r.restarted ? ' RESTART' : ''}`)
      .join('; ')
    const p50 = sortedEdit[Math.floor(sortedEdit.length / 2)]
    const summary =
      `note_history: ${histSummary}. ` +
      `Thresholds on the ${bigKiB} KiB note: >50 MB at ${thresholds.over50MB?.revs ?? `>${revs}`} revisions, >30 s at ${thresholds.over30s?.revs ?? `>${revs}`}, restart at ${thresholds.restartOrFailure?.revs ?? `>${revs} (single call)`}. ` +
      `${bigKiB} KiB edit_note p50 ${p50 === undefined ? '-' : Math.round(p50)} ms over ${edits} grow edits. ` +
      `Collab >1 MiB: ${collab.map((c) => `${c.mib} MiB stored=${c.storedInDb}`).join(', ')}; REST ${rest.status}, MCP ${mcpOver.httpStatus} for 1.5 MiB.`
    return {
      summary,
      checks,
      data: { vaultId: vault.id, rows, thresholds, bytesPerRevKiB, editMs: { n: editMs.length, p50, p95: sortedEdit[Math.floor(sortedEdit.length * 0.95)], max: sortedEdit.at(-1) }, fanout, collab, collabHistory, notableLogs: notable, restartFinal },
    }
  },
}
export default test
