// ADR-003 §5.4 and §11 scenario cases for S2b (id-named collab documents,
// the CRDT state in Postgres, the rebase of a row changed behind the store).
// Each scenario drives a real @hocuspocus/provider client (lib/collab.ts)
// against the instance and checks disk, DB and client by counting markers:
//
// - rename A→B, a new note created at A, the old tab reconnects: its typing
//   lands in B once, the new A is untouched (documents are named by id);
// - a tab of a pre-S2b bundle (path-named document) with unsent typing: the
//   relay refuses it with `reload-required` and stores nothing; after the
//   reload its kept copy (#720) shares history with the note and merges once;
// - a kept copy whose history the note no longer has (a bin set aside, the
//   note re-seeded): the client's sharesHistory rule offers it, nothing doubles;
// - type, rename before the store debounce, SIGKILL: the typing is in the
//   renamed note once (the rename folds it first, Invariant W);
// - type, change the row by SQL (another line, then the same line), reload:
//   both sides survive once each (three-way rebase, per character in a line).
import type { Check, LabContext, LabTest } from '../lib/context.ts'
import { CollabClient, Y, collabDocName } from '../lib/collab.ts'
import { RestSession } from '../lib/rest.ts'
import { count, dbBody, dumpVault } from '../lib/datapath.ts'

const SETTLE_MS = 3500 // COLLAB_DEBOUNCE_MS 2000 + margin

/** The client's rule (client/src/hooks/useCollabDoc.ts sharesHistory): a Yjs client in common. */
function sharesHistory(a: Y.Doc, b: Y.Doc): boolean {
  for (const client of a.store.clients.keys()) if (b.store.clients.has(client)) return true
  return false
}

const test: LabTest = {
  name: 'collab-s2b',
  description: 'ADR-003 S2b scenarios: rename + new note at the old path, pre-S2b tab across the upgrade, re-seeded copy, rename then SIGKILL, row changed by SQL.',
  async run(ctx: LabContext) {
    const checks: Check[] = []
    const data: Record<string, unknown> = {}
    const u = Math.random().toString(36).slice(2, 7)
    const mk = (n: string) => `@${n}-${u}@`
    const mcp = ctx.mcp('adminAccount')
    const admin = ctx.env.users.admin
    const vault = await ctx.createVault('admin', ctx.uniq('s2b'))
    const sess = await RestSession.login(ctx.baseUrl, admin.email, admin.password)
    const rest = ctx.rest('admin')

    async function createNote(path: string, body: string): Promise<string> {
      return (await mcp.must<{ id: string }>('create_note', { vaultId: vault.id, path, body })).id
    }
    async function rename(from: string, to: string) {
      const r = await rest.request('POST', `/api/vaults/${vault.id}/notes-rename`, { from, to })
      if (r.status !== 200) throw new Error(`rename ${from} -> ${to}: HTTP ${r.status}`)
    }
    /** Disk (once the projector caught up with the row, up to 20 s) and DB bodies of note `id` at `path`. */
    async function bodies(id: string, path: string): Promise<{ disk: string | null; db: string }> {
      let disk: string | null = null
      let db = ''
      for (let i = 0; i < 40; i++) {
        db = await dbBody(ctx, id)
        disk = (await dumpVault(vault.id, [path])).notes.find((n) => n.path === path)?.body ?? null
        if (disk === db) break
        await Bun.sleep(500)
      }
      return { disk, db }
    }
    /** One check: `marker` exactly once in every source given. */
    function once(name: string, marker: string, sources: Record<string, string | null>) {
      const counts = Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v === null ? -1 : count(v, marker)]))
      checks.push({
        name,
        expected: 'exactly once in each of ' + Object.keys(sources).join(', '),
        actual: JSON.stringify(counts),
        ok: Object.values(counts).every((n) => n === 1),
        severity: 'critical',
      })
    }

    // ---------------------------------------------------------------- rename A→B, new A, old tab reconnects
    {
      const a = 'stwob/alpha'
      const base = mk('RBASE')
      const id = await createNote(a, `${base}\n`)
      const tab = new CollabClient(ctx.baseUrl, collabDocName(vault.id, id), sess)
      await tab.connect()
      tab.disconnect()
      await rename(a, 'beta')
      const newA = await createNote(a, 'a new note at the old path\n')
      const m = mk('RTAB')
      tab.type(`\n${m}`)
      const back = await tab.reconnect()
      await tab.waitAcked()
      await Bun.sleep(SETTLE_MS)
      const b = await bodies(id, 'stwob/beta')
      const fresh = await bodies(newA, a)
      once('S2b-rename: old tab typing after rename A→B and a new A lands in B once', m, { disk: b.disk, db: b.db, client: tab.body })
      checks.push({
        name: 'S2b-rename: the new note at the old path is untouched',
        expected: 'body unchanged, no marker',
        actual: JSON.stringify({ db: fresh.db, disk: fresh.disk }),
        ok: fresh.db === 'a new note at the old path\n' && fresh.disk === fresh.db,
        severity: 'critical',
      })
      data.rename = { reconnected: back, beta: b, newA: fresh }
      tab.destroy()
    }

    // ---------------------------------------------------------------- pre-S2b tab across the upgrade
    {
      const p = 'stwob/upgrade'
      const base = mk('UBASE')
      const id = await createNote(p, `${base}\n`)
      // The tab's history: the note's own document (before S2b, the relay attached its bin to it).
      const seen = new CollabClient(ctx.baseUrl, collabDocName(vault.id, id), sess)
      await seen.connect()
      seen.destroy()
      const stash = seen.ydoc
      const m = mk('UTAB')
      stash.getText('body').insert(stash.getText('body').length, `${m}\n`)
      // The old bundle names the document by path.
      const old = new CollabClient(ctx.baseUrl, `${vault.id}/${p}`, sess, stash)
      await old.connect(15_000)
      checks.push({
        name: 'S2b-upgrade: a path-named tab is refused with reload-required',
        expected: 'reload-required',
        actual: String(old.authFailed),
        ok: old.authFailed === 'reload-required',
        severity: 'high',
      })
      old.destroy()
      await Bun.sleep(SETTLE_MS)
      const refused = await bodies(id, p)
      checks.push({
        name: 'S2b-upgrade: nothing the refused tab sent is stored',
        expected: 'marker absent from DB and disk',
        actual: JSON.stringify({ db: count(refused.db, m), disk: refused.disk === null ? -1 : count(refused.disk, m) }),
        ok: count(refused.db, m) === 0 && refused.disk !== null && count(refused.disk, m) === 0,
        severity: 'critical',
      })
      // The reload: a fresh document by id; the kept copy is merged once it shares history (the client's rule).
      const reloaded = new CollabClient(ctx.baseUrl, collabDocName(vault.id, id), sess)
      await reloaded.connect()
      const shared = sharesHistory(stash, reloaded.ydoc)
      if (shared) Y.applyUpdate(reloaded.ydoc, Y.encodeStateAsUpdate(stash, Y.encodeStateVector(reloaded.ydoc)))
      await reloaded.waitAcked()
      await Bun.sleep(SETTLE_MS)
      const after = await bodies(id, p)
      once('S2b-upgrade: the kept typing merges once after the reload', m, { disk: after.disk, db: after.db, client: reloaded.body })
      once('S2b-upgrade: the note text is not doubled by the merge', base, { disk: after.disk, db: after.db, client: reloaded.body })
      data.upgrade = { shared, refused, after }
      reloaded.destroy()
    }

    // ---------------------------------------------------------------- a kept copy without shared history (bin set aside, re-seeded)
    {
      const p = 'stwob/reseeded'
      const base = mk('SBASE')
      const id = await createNote(p, `${base}\n`)
      // The copy holds the lineage of a bin the backfill set aside: the same text, items of its own.
      const copy = new Y.Doc()
      const m = mk('STAB')
      copy.getText('body').insert(0, `${base}\n${m}\n`)
      const tab = new CollabClient(ctx.baseUrl, collabDocName(vault.id, id), sess)
      await tab.connect()
      const shared = sharesHistory(copy, tab.ydoc)
      // The client offers the copy's text instead of merging it: nothing reaches the document.
      if (shared) Y.applyUpdate(tab.ydoc, Y.encodeStateAsUpdate(copy, Y.encodeStateVector(tab.ydoc)))
      await tab.waitAcked()
      await Bun.sleep(SETTLE_MS)
      const after = await bodies(id, p)
      checks.push({
        name: 'S2b-reseeded: a copy without shared history is offered, not merged',
        expected: 'no shared history; base once, the copy marker absent',
        actual: JSON.stringify({ shared, base: count(after.db, base), marker: count(after.db, m) }),
        ok: !shared && count(after.db, base) === 1 && count(after.db, m) === 0 && after.disk === after.db,
        severity: 'critical',
      })
      data.reseeded = { shared, after }
      tab.destroy()
    }

    // ---------------------------------------------------------------- type, rename before the debounce, SIGKILL
    {
      const p = 'stwob/rename-kill'
      const id = await createNote(p, `${mk('KBASE')}\n`)
      const tab = new CollabClient(ctx.baseUrl, collabDocName(vault.id, id), sess)
      await tab.connect()
      const m = mk('KTAB')
      tab.type(`\n${m}`)
      await tab.waitAcked()
      await rename(p, 'rename-killed')
      const crash = await ctx.docker.app.crash(ctx.baseUrl)
      const back = await tab.waitSynced(60_000)
      await tab.waitAcked()
      await Bun.sleep(SETTLE_MS)
      const after = await bodies(id, 'stwob/rename-killed')
      once('S2b-rename-kill: typing before a rename, then SIGKILL, is in the renamed note once', m, {
        disk: after.disk,
        db: after.db,
        client: tab.body,
      })
      data.renameKill = { crash, reconnected: back, after }
      tab.destroy()
    }

    // ---------------------------------------------------------------- type, change the row by SQL, reload
    {
      const p = 'stwob/sql-row'
      const id = await createNote(p, 'first line\nsecond line\n')
      const tab = new CollabClient(ctx.baseUrl, collabDocName(vault.id, id), sess)
      await tab.connect()
      const m = mk('QTAB')
      tab.type(`${m} `, 0)
      await tab.waitAcked()
      await Bun.sleep(SETTLE_MS)
      tab.destroy()
      // Another line by SQL, and a different word of the line the tab typed in.
      const sqlLine = mk('QSQL')
      const stored = await dbBody(ctx, id)
      const changed = stored.replace('first line', 'first LINE').replace('second line\n', `second line\n${sqlLine}\n`)
      await ctx.docker.psql(`UPDATE notes SET body = '${changed.replace(/'/g, "''")}' WHERE id = '${id}'`)
      await ctx.docker.app.restart(ctx.baseUrl)
      const reloaded = new CollabClient(ctx.baseUrl, collabDocName(vault.id, id), sess, tab.ydoc)
      await reloaded.connect()
      await Bun.sleep(SETTLE_MS)
      const after = await bodies(id, p)
      const sources = { disk: after.disk, db: after.db, client: reloaded.body }
      once('S2b-sql-row: typing survives a row changed by SQL, once', m, sources)
      once('S2b-sql-row: the SQL change on another line survives, once', sqlLine, sources)
      once('S2b-sql-row: the SQL change in the typed line survives, once', 'first LINE', sources)
      data.sqlRow = { after }
      reloaded.destroy()
    }

    const failed = checks.filter((c) => c.ok !== true)
    return {
      summary: `${checks.length - failed.length}/${checks.length} S2b scenario checks passed${failed.length ? `; failed: ${failed.map((c) => c.name).join('; ')}` : ''}.`,
      checks,
      data,
    }
  },
}
export default test
