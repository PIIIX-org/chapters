// Is the #379 text-duplication bug class still alive?
//
// #379 (commit afed492) made the relay persist the Yjs state next to the
// note; since ADR-003 S2b that state lives in Postgres (`note_crdt` snapshot
// plus the `note_updates` log, server/src/sync/note-crdt.ts), the relay
// names documents `<vaultId>/~<noteId>`, and a load merges a row changed
// behind the CRDT state into it instead of rebuilding the text. Duplication
// happens when a client holding Yjs items the server no longer knows (a
// stale Y.Doc) reconnects to a server document rebuilt with NEW items for
// the same text.
// This test drives a real @hocuspocus/provider client exactly like
// client/src/hooks/useCollabDoc.ts (ticket per connect, same Y.Doc across
// reconnects) through: typing, network blips, unmount/remount, offline edits,
// MCP edit_note while connected / concurrent / while offline, logout+login,
// graceful restart, SIGKILL, a SIGKILL timing sweep around the store
// debounce, a database restore with a tab left open (S18 backup restore,
// the documented infrastructure backup and restore: it guards that path),
// and the CRDT state put back by SQL behind a newer row (S18 SQL, S19): the
// state the old relay's crash window left (note written, CRDT state not),
// which since S2b only a manual change of `note_crdt`/`note_updates` leaves.
// The S18 SQL step is the faithful reproduction of #488's mechanism; its
// stale-tab checks are baselined under #891. S19 keeps ".crdt" in its check
// names from before S2b.
//
// After every step: body on disk (parsed by the app's own parseNote inside
// the container), notes.body in Postgres, the note's CRDT state decoded from
// Postgres and every connected client are compared, and every marker ever
// typed is counted in each. Any count > 1 = duplication.
import type { Check, LabContext, LabTest } from '../lib/context.ts'
import { CollabClient, Y, collabDocName } from '../lib/collab.ts'
import { RestSession } from '../lib/rest.ts'
import { appLogsSince, backupInstance, count, dbBody, dbNotes, dumpVault, genBody, restoreCrdtState, restoreInstance, saveCrdtState, sha } from '../lib/datapath.ts'

const SETTLE_MS = 3500 // COLLAB_DEBOUNCE_MS default 2000 (collab-server.ts:18) + margin

interface SourceView {
  len: number
  sha: string
}

interface StepRecord {
  step: string
  note: string
  sources: Record<string, SourceView | null>
  /** marker -> source -> count (only markers seen anywhere or expected). */
  counts: Record<string, Record<string, number>>
  expectedLen: number | null
  diskEqualsExpected: boolean | null
  duplicated: string[]
  converged: boolean
  revs: number | null
  note2?: string
  extra?: Record<string, unknown>
}

const test: LabTest = {
  name: 'collab-duplication',
  tier: 'fast',
  description: 'Hocuspocus client vs MCP vs restarts/crashes: any duplicated text on disk, in DB, in .crdt or in clients (#379 class).',
  async run(ctx: LabContext) {
    const checks: Check[] = []
    const steps: StepRecord[] = []
    const startedIso = new Date().toISOString()
    const u = Math.random().toString(36).slice(2, 7)
    const mk = (n: string) => `@${n}-${u}@`
    /** A marker without this run's suffix, so check names are the same in every run (lab/known-defects.json). */
    const label = (m: string) => m.replace(`-${u}@`, '@')
    const markers: string[] = []
    const mcp = ctx.mcp('adminAccount')
    const admin = ctx.env.users.admin

    const vault = await ctx.createVault('admin', ctx.uniq('dup'))
    const sess = await RestSession.login(ctx.baseUrl, admin.email, admin.password)

    async function createNote(path: string, body: string): Promise<string> {
      const row = await mcp.must<{ id: string }>('create_note', { vaultId: vault.id, path, body })
      return row.id
    }

    /** Compare all sources for one note; record and emit checks. */
    async function snap(
      step: string,
      note: { path: string; id: string },
      clients: Record<string, CollabClient>,
      expect: { once?: string[]; absent?: string[]; expected?: string | null; checkConverged?: boolean } = {},
      extra?: Record<string, unknown>,
    ): Promise<StepRecord> {
      const dump = await dumpVault(vault.id, [note.path])
      const disk = dump.notes.find((n) => n.path === note.path)
      const crdt = dump.crdt.find((c) => c.path === note.path)
      const db = await dbBody(ctx, note.id)
      const revs = (await dbNotes(ctx, vault.id)).find((r) => r.id === note.id)?.revs ?? null
      const bodies: Record<string, string | null> = {
        disk: disk?.parseOk ? (disk.body ?? '') : null,
        db,
        crdt: crdt?.decodeError ? null : (crdt?.body ?? null),
      }
      for (const [name, c] of Object.entries(clients)) bodies[`client:${name}`] = c.provider ? c.body : null
      const sources: Record<string, SourceView | null> = {}
      for (const [k, b] of Object.entries(bodies)) sources[k] = b === null ? null : { len: b.length, sha: sha(b).slice(0, 12) }
      const counts: Record<string, Record<string, number>> = {}
      const duplicated: string[] = []
      for (const m of markers) {
        const per: Record<string, number> = {}
        let any = false
        for (const [k, b] of Object.entries(bodies)) {
          if (b === null) continue
          per[k] = count(b, m)
          if (per[k]! > 0) any = true
          if (per[k]! > 1) duplicated.push(`${m} x${per[k]} in ${k}`)
        }
        if (any || expect.once?.includes(m) || expect.absent?.includes(m)) counts[m] = per
      }
      const present = Object.values(bodies).filter((b): b is string => b !== null)
      const converged = present.every((b) => b === present[0])
      const rec: StepRecord = {
        step,
        note: note.path,
        sources,
        counts,
        expectedLen: expect.expected == null ? null : expect.expected.length,
        diskEqualsExpected: expect.expected == null ? null : bodies.disk === expect.expected,
        duplicated,
        converged,
        revs,
        extra,
      }
      steps.push(rec)
      ctx.log(`${step}: dup=${duplicated.length} converged=${converged} ${JSON.stringify(sources)}`)

      checks.push({
        name: `${step}: no duplicated text`,
        expected: 'every marker at most once in disk, DB, .crdt and clients',
        actual: duplicated.length === 0 ? 'none duplicated' : duplicated.join('; '),
        ok: duplicated.length === 0,
        severity: 'critical',
      })
      if (expect.checkConverged !== false) {
        checks.push({
          name: `${step}: disk = DB = .crdt = clients`,
          expected: 'identical bodies',
          actual: converged ? 'identical' : JSON.stringify(sources),
          ok: converged,
          severity: 'high',
        })
      }
      if (expect.expected != null) {
        checks.push({
          name: `${step}: disk body equals the expected edit sequence`,
          expected: `len ${expect.expected.length}`,
          actual: bodies.disk === expect.expected ? 'equal' : `disk len ${bodies.disk?.length ?? 'n/a'}`,
          ok: bodies.disk === expect.expected,
          severity: 'high',
        })
      }
      for (const m of expect.once ?? []) {
        const n = bodies.disk == null ? -1 : count(bodies.disk, m)
        checks.push({
          name: `${step}: ${label(m)} kept exactly once on disk`,
          expected: '1',
          actual: String(n),
          ok: n === 1,
          severity: 'high',
        })
      }
      for (const m of expect.absent ?? []) {
        const n = bodies.disk == null ? -1 : count(bodies.disk, m)
        checks.push({ name: `${step}: ${label(m)} gone from disk`, expected: '0', actual: String(n), ok: n === 0, severity: 'medium' })
      }
      return rec
    }

    async function settle(...clients: CollabClient[]) {
      for (const c of clients) await c.waitAcked()
      await Bun.sleep(SETTLE_MS)
    }

    async function typeMarker(c: CollabClient, name: string): Promise<string> {
      const m = mk(name)
      markers.push(m)
      c.type(`\n${m}`)
      return m
    }

    // ------------------------------------------------------------ note 1
    const p1 = 'dup/note-one'
    const base = mk('BASE')
    markers.push(base)
    let expected = `${base}\n\n${genBody(2000, 11)}\nend of base`
    const n1 = { path: p1, id: await createNote(p1, expected) }
    const docName = collabDocName(vault.id, n1.id)

    const A = new CollabClient(ctx.baseUrl, docName, sess)
    const okA = await A.connect()
    checks.push({ name: 'client A connects with a ticket', expected: 'synced', actual: okA ? 'synced' : `status ${A.status} auth ${A.authFailed}`, ok: okA ? true : null, severity: 'high' })
    if (!okA) {
      return { summary: `collab client could not connect (${A.status}, ${A.authFailed}); nothing measured.`, checks, data: { events: A.events } }
    }
    await snap('S01 connect', n1, { A }, { once: [base], expected })

    // S02 typing
    expected += `\n${await typeMarker(A, 'M02')}`
    await settle(A)
    await snap('S02 type', n1, { A }, { once: [mk('M02')], expected })

    // S03 network blip, same provider + ydoc
    A.disconnect()
    await Bun.sleep(1000)
    const r3 = await A.reconnect()
    expected += `\n${await typeMarker(A, 'M03')}`
    await settle(A)
    await snap('S03 blip reconnect', n1, { A }, { once: [mk('M03'), base], expected }, { reconnected: r3 })

    // S04 unmount, server unloads the doc, remount with the SAME ydoc (hook keeps the doc for an unchanged docName)
    A.destroy()
    await Bun.sleep(6000)
    const r4 = await A.connect()
    expected += `\n${await typeMarker(A, 'M04')}`
    await settle(A)
    await snap('S04 remount same ydoc after unload', n1, { A }, { once: [mk('M04'), base], expected }, { reconnected: r4 })

    // S05 page reload: fresh ydoc
    A.destroy()
    A.ydoc = new Y.Doc()
    const r5 = await A.connect()
    await settle(A)
    await snap('S05 remount fresh ydoc', n1, { A }, { once: [base], expected }, { reconnected: r5 })

    // S06 offline typing then reconnect
    A.disconnect()
    await Bun.sleep(300)
    expected += `\n${await typeMarker(A, 'M06')}`
    await Bun.sleep(700)
    const r6 = await A.reconnect()
    await settle(A)
    await snap('S06 offline typing + reconnect', n1, { A }, { once: [mk('M06'), base], expected }, { reconnected: r6 })

    // S07 MCP edit_note while connected (full body replace through the relay, crdt-write.ts:63-74)
    const s07 = mk('MCP07')
    markers.push(s07)
    expected = `${s07}\n\n${genBody(2500, 7)}\nend of mcp 07`
    const e7 = await mcp.call('edit_note', { vaultId: vault.id, path: p1, body: expected })
    for (let i = 0; i < 100 && !A.body.includes(s07); i++) await Bun.sleep(100)
    await settle(A)
    await snap('S07 MCP edit while connected', n1, { A }, { once: [s07], absent: [base, mk('M02')], expected }, { mcpOk: e7.ok, mcpText: e7.ok ? undefined : e7.text })

    // S08 MCP edit concurrent with typing
    const s08 = mk('MCP08')
    markers.push(s08)
    const body08 = `${s08}\n\n${genBody(2500, 8)}\nend of mcp 08`
    const chunks: string[] = []
    const typing = (async () => {
      for (let i = 0; i < 20; i++) {
        const m = mk(`T08x${String(i).padStart(2, '0')}`)
        markers.push(m)
        chunks.push(m)
        A.type(` ${m}`)
        await Bun.sleep(30)
      }
    })()
    await Bun.sleep(100)
    const e8 = await mcp.call('edit_note', { vaultId: vault.id, path: p1, body: body08 })
    await typing
    await settle(A)
    const rec8 = await snap('S08 MCP edit concurrent with typing', n1, { A }, { once: [s08], absent: [s07] }, { mcpOk: e8.ok })
    const survivors = chunks.filter((m) => (rec8.counts[m]?.disk ?? 0) > 0).length
    rec8.extra = { ...rec8.extra, typedChunks: chunks.length, chunksOnDisk: survivors }
    expected = (await dumpVault(vault.id, [p1])).notes.find((n) => n.path === p1)?.body ?? expected

    // S09 offline typing + MCP edit while client offline, then reconnect
    A.disconnect()
    await Bun.sleep(300)
    const m09 = await typeMarker(A, 'M09')
    const s09 = mk('MCP09')
    markers.push(s09)
    const body09 = `${s09}\n\n${genBody(2500, 9)}\nend of mcp 09`
    const e9 = await mcp.call('edit_note', { vaultId: vault.id, path: p1, body: body09 })
    const r9 = await A.reconnect()
    await settle(A)
    const rec9 = await snap('S09 MCP edit while client offline', n1, { A }, { once: [s09], absent: [s08] }, { mcpOk: e9.ok, reconnected: r9 })
    rec9.extra = { ...rec9.extra, offlineTypedKept: rec9.counts[m09]?.disk ?? 0 }
    expected = (await dumpVault(vault.id, [p1])).notes.find((n) => n.path === p1)?.body ?? expected

    // S10 second editor joins, both type
    const B = new CollabClient(ctx.baseUrl, docName, sess)
    const okB = await B.connect()
    const m10a = await typeMarker(A, 'M10A')
    const m10b = await typeMarker(B, 'M10B')
    await settle(A, B)
    await snap('S10 two editors', n1, { A, B }, { once: [m10a, m10b, s09] }, { bConnected: okB })
    B.destroy()
    expected = (await dumpVault(vault.id, [p1])).notes.find((n) => n.path === p1)?.body ?? expected

    // S11 logout while connected
    const L1 = await RestSession.login(ctx.baseUrl, admin.email, admin.password)
    A.destroy()
    A.session = L1
    await A.connect()
    const logout = await L1.post('/api/logout')
    await Bun.sleep(1500)
    const stillConnected = A.status === 'connected'
    const m11 = await typeMarker(A, 'M11')
    const acked11 = await A.waitAcked(5000)
    await Bun.sleep(SETTLE_MS)
    const disk11 = (await dumpVault(vault.id, [p1])).notes.find((n) => n.path === p1)?.body ?? ''
    const persisted11 = count(disk11, m11)
    checks.push({
      name: 'S11 logout ends the live collab session',
      expected: 'socket closed or edits refused after POST /api/logout',
      actual: `logout HTTP ${logout.status}; socket ${stillConnected ? 'still connected' : A.status}; edit typed after logout ${acked11 ? 'acked' : 'not acked'} and ${persisted11 > 0 ? 'WRITTEN to disk' : 'not written'}`,
      ok: !(stillConnected && persisted11 > 0),
      severity: 'medium',
    })
    if (persisted11 > 0) expected = disk11
    A.disconnect()
    await Bun.sleep(300)
    const reconnectAfterLogout = await A.reconnect(8000)
    checks.push({
      name: 'S11 reconnect with a logged-out session is refused',
      expected: 'ticket refused, not connected',
      actual: reconnectAfterLogout ? 'reconnected' : `not connected (ticket errors ${A.ticketErrors})`,
      ok: !reconnectAfterLogout,
      severity: 'high',
    })
    steps.push({
      step: 'S11 logout while connected',
      note: p1,
      sources: {},
      counts: {},
      expectedLen: null,
      diskEqualsExpected: null,
      duplicated: [],
      converged: true,
      revs: null,
      extra: { logoutStatus: logout.status, stillConnected, acked11, persisted11, reconnectAfterLogout, ticketErrors: A.ticketErrors },
    })

    // S12 log in again in the same tab: same user -> the hook keeps the ydoc (useCollabDoc.ts:132-143)
    const L2 = await RestSession.login(ctx.baseUrl, admin.email, admin.password)
    A.destroy()
    A.session = L2
    const r12 = await A.connect()
    const m12 = await typeMarker(A, 'M12')
    await settle(A)
    await snap('S12 re-login same ydoc', n1, { A }, { once: [m12, s09] }, { reconnected: r12 })

    // S13 re-login with page reload (fresh ydoc)
    A.destroy()
    A.ydoc = new Y.Doc()
    const r13 = await A.connect()
    await settle(A)
    await snap('S13 re-login fresh ydoc', n1, { A }, { once: [m12, s09] }, { reconnected: r13 })
    expected = A.body

    // S14 graceful restart with a dirty doc (index.ts flushes the debounce on SIGTERM)
    const m14 = await typeMarker(A, 'M14')
    expected += `\n${m14}`
    await A.waitAcked()
    const restart = await ctx.docker.app.restart(ctx.baseUrl)
    const r14 = await A.waitSynced(60_000)
    await settle(A)
    await snap('S14 graceful restart, dirty doc, client stays', n1, { A }, { once: [m14, s09], expected }, { restart, reconnected: r14 })

    // S15 SIGKILL with a dirty doc, client stays and resyncs
    const m15 = await typeMarker(A, 'M15')
    expected += `\n${m15}`
    await A.waitAcked()
    const crash15 = await ctx.docker.app.crash(ctx.baseUrl)
    const r15 = await A.waitSynced(60_000)
    await settle(A)
    await snap('S15 SIGKILL, dirty doc, client stays', n1, { A }, { once: [m15, s09], expected }, { crash: crash15, reconnected: r15 })

    // S16 SIGKILL with a dirty doc after the only client left (closed tab), then the tab comes back
    const m16 = await typeMarker(A, 'M16')
    const acked16 = await A.waitAcked()
    A.destroy()
    const crash16 = await ctx.docker.app.crash(ctx.baseUrl)
    const disk16 = (await dumpVault(vault.id, [p1])).notes.find((n) => n.path === p1)?.body ?? ''
    checks.push({
      name: 'S16 server-acknowledged collab edit survives SIGKILL after the tab closed',
      expected: 'on disk (the relay acked it before the kill)',
      actual: `acked ${acked16}; on disk after restart: ${count(disk16, m16)}`,
      ok: count(disk16, m16) === 1,
      severity: 'high',
    })
    const r16 = await A.connect()
    await settle(A)
    await snap('S16 tab returns with stale ydoc after crash', n1, { A }, { once: [m16, s09] }, { crash: crash16, ackedBeforeKill: acked16, onDiskBeforeReturn: count(disk16, m16), reconnected: r16 })

    // S17 SIGKILL timing sweep around the store debounce, client stays.
    // Eight crash/restart cycles: full tier only.
    const sweep: Record<string, unknown>[] = []
    let killLatency = 150
    for (const d of ctx.tier === 'full' ? [1700, 1900, 2000, 2050, 2100, 2150, 2250, 2500] : []) {
      const m = await typeMarker(A, `M17d${d}`)
      await A.waitAcked()
      // The relay's debounce timer starts when it receives the update (~ack time);
      // aim the SIGKILL at `d` ms after that, minus the measured `docker kill` latency.
      const wait = d - killLatency
      if (wait > 0) await Bun.sleep(wait)
      const c = await ctx.docker.app.crash(ctx.baseUrl)
      killLatency = Math.max(30, Math.min(800, c.killMs))
      const synced = await A.waitSynced(60_000)
      await settle(A)
      const rec = await snap(`S17 SIGKILL ${d} ms after ack`, n1, { A }, { once: [m] }, { crash: c, reconnected: synced })
      sweep.push({ delayMs: d, killMs: Math.round(c.killMs), dup: rec.duplicated, onDisk: rec.counts[m]?.disk ?? 0, converged: rec.converged })
    }

    // ------------------------------------------------------------ note 2: a database restore with a tab left open
    // The supported way to put a note's stored state back behind what a tab
    // holds (#488): the infrastructure backup and restore of
    // docs/self-hosting/backup.md §1-2. `pg_dump` reads one snapshot, so the
    // row, its revisions and its CRDT state come back together; the tab
    // typed after the backup and stays open through the downtime (its
    // session is in the dump), so it reconnects with the same Y.Doc, holding
    // items the restored server no longer has. Then a page reload joins.
    const injection: Record<string, unknown>[] = []
    const pR = 'dup/note-restore'
    const baseR = mk('BASER')
    markers.push(baseR)
    const nR = { path: pR, id: await createNote(pR, `${baseR}\n\n${genBody(1500, 21)}\nend of base restore`) }
    const R = new CollabClient(ctx.baseUrl, collabDocName(vault.id, nR.id), sess)
    await R.connect()
    await settle(R)
    const backup = await backupInstance(vault.id)
    const mR = await typeMarker(R, 'INJRESTORE')
    await settle(R)
    const storedBeforeRestore = count(await dbBody(ctx, nR.id), mR)
    // The downtime drops the tab's socket; its provider would retry on its
    // own. It is held down here until the restored state has been read, so
    // that reading never races the tab's reconnect.
    R.disconnect()
    const restore = await restoreInstance(ctx.baseUrl, vault.id)
    const restored = await dumpVault(vault.id, [pR])
    const restoredCounts = {
      disk: count(restored.notes.find((n) => n.path === pR)?.body ?? '', mR),
      db: count(await dbBody(ctx, nR.id), mR),
      crdt: count(restored.crdt.find((c) => c.path === pR)?.body ?? '', mR),
    }
    checks.push({
      name: 'S18 backup restore: the restore took the note back to the backup (the marker typed after it was stored, then gone from disk, DB and .crdt)',
      expected: 'stored 1 before the restore; disk 0, db 0, crdt 0 after it',
      actual: `stored ${storedBeforeRestore}; ${JSON.stringify(restoredCounts)}`,
      ok: storedBeforeRestore === 1 && restoredCounts.disk === 0 && restoredCounts.db === 0 && restoredCounts.crdt === 0,
      severity: 'high',
    })
    const backAfterRestore = await R.reconnect(60_000)
    await settle(R)
    const F = new CollabClient(ctx.baseUrl, collabDocName(vault.id, nR.id), sess)
    const okF = await F.connect()
    await settle(F)
    const recR = await snap(
      'S18 backup restore, stale ydoc (tab kept open) + page reload',
      nR,
      { R, F },
      { once: [mR, baseR] },
      { backup, restore, storedBeforeRestore, restoredCounts, reconnected: backAfterRestore, reloadConnected: okF },
    )
    injection.push({ variant: 'backup restore, tab kept open', marker: mR, restoredCounts, after: recR.counts[mR], duplicated: recR.duplicated })
    R.destroy()
    F.destroy()

    // ------------------------------------------------------------ note 2b: the CRDT state put back by SQL
    // The old relay wrote the note and only then its .crdt bin; a SIGKILL
    // between the two left file = new, CRDT state = old. Since S2b the row and
    // the CRDT state share a transaction, so only a manual change of
    // note_crdt/note_updates leaves it (#891). Reproduced deterministically:
    // save the note's CRDT state, let one edit store, restart gracefully (doc
    // unloaded), put the old state back by SQL.
    const p2 = 'dup/note-two'
    const base2 = mk('BASE2')
    markers.push(base2)
    const body2 = `${base2}\n\n${genBody(1500, 22)}\nend of base 2`
    const n2 = { path: p2, id: await createNote(p2, body2) }
    for (const variant of ['fresh ydoc (page reload)', 'stale ydoc (tab kept open)'] as const) {
      const C = new CollabClient(ctx.baseUrl, collabDocName(vault.id, n2.id), sess)
      await C.connect()
      await settle(C)
      await saveCrdtState(ctx, n2.id)
      const m = await typeMarker(C, variant.startsWith('fresh') ? 'INJFRESH' : 'INJSTALE')
      await settle(C)
      C.destroy()
      await ctx.docker.app.restart(ctx.baseUrl)
      await restoreCrdtState(ctx, n2.id)
      const before = await dumpVault(vault.id, [p2])
      const diskBefore = count(before.notes.find((n) => n.path === p2)?.body ?? '', m)
      const binBefore = count(before.crdt.find((c) => c.path === p2)?.body ?? '', m)
      if (variant.startsWith('fresh')) C.ydoc = new Y.Doc()
      const ok = await C.connect()
      await settle(C)
      const rec = await snap(`S18 CRDT state put back by SQL, ${variant}`, n2, { C }, { once: [m, base2] }, { diskBefore, binBefore, reconnected: ok })
      injection.push({ variant: `SQL, ${variant}`, marker: m, diskBefore, binBefore, after: rec.counts[m], duplicated: rec.duplicated })
      C.destroy()
    }

    // ------------------------------------------------------------ note 3: a stale CRDT state is a lasting hazard
    // The old relay's load rewrote the body with NEW Yjs items but never
    // saved them, so a session that only reads never persisted that lineage.
    // Chain after one CRDT state put back by SQL (as in note 2b): a tab opens
    // the note (fresh ydoc), stays idle, its network drops long enough for
    // the doc to unload, it reconnects.
    const p3 = 'dup/note-three'
    const base3 = mk('BASE3')
    markers.push(base3)
    const n3 = { path: p3, id: await createNote(p3, `${base3}\n\n${genBody(1500, 33)}\nend of base 3`) }
    const D = new CollabClient(ctx.baseUrl, collabDocName(vault.id, n3.id), sess)
    await D.connect()
    await settle(D)
    await saveCrdtState(ctx, n3.id)
    const m19 = await typeMarker(D, 'IDLE')
    await settle(D)
    D.destroy()
    await ctx.docker.app.restart(ctx.baseUrl)
    await restoreCrdtState(ctx, n3.id)
    const E = new CollabClient(ctx.baseUrl, collabDocName(vault.id, n3.id), sess)
    const e1 = await E.connect()
    await Bun.sleep(SETTLE_MS) // read-only session: nothing typed
    await snap('S19a stale .crdt, fresh tab opens (reads only)', n3, { E }, { once: [base3, m19], checkConverged: false }, { reconnected: e1 })
    E.disconnect()
    await Bun.sleep(6000) // no connections, nothing to store -> the relay unloads the doc
    const e2 = await E.reconnect()
    await settle(E)
    const rec19 = await snap('S19b same idle tab reconnects after the doc unloaded', n3, { E }, { once: [base3, m19] }, { reconnected: e2 })
    E.destroy()
    injection.push({ variant: 'idle tab after unload (no second crash)', marker: m19, after: rec19.counts[m19], base: rec19.counts[base3], duplicated: rec19.duplicated })

    A.destroy()
    const logs = await appLogsSince(startedIso, 300)
    const collabErrors = logs.split('\n').filter((l) => /collab store rejected|crdt state save rejected|\[collab\]/.test(l)).slice(0, 40)

    const dupSteps = steps.filter((s) => s.duplicated.length > 0)
    const divergedSteps = steps.filter((s) => !s.converged)
    const summary =
      `${steps.length} steps on 4 notes with a real @hocuspocus/provider client (ticket auth, Y.Doc reuse like useCollabDoc.ts). ` +
      `Duplication in ${dupSteps.length} step(s)${dupSteps.length ? `: ${dupSteps.map((s) => s.step).join(', ')}` : ''}. ` +
      `Disk/DB/.crdt/client divergence in ${divergedSteps.length} step(s)${divergedSteps.length ? `: ${divergedSteps.map((s) => s.step).join(', ')}` : ''}. ` +
      `Stale stored state (restore, SQL): ${injection.map((i) => `${i.variant} -> ${JSON.stringify(i.after)}`).join('; ')}.`
    return { summary, checks, data: { vaultId: vault.id, steps, sweep, injection, collabErrors } }
  },
}
export default test
