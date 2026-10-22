// ADR-003 §11 store-rollback, the code-only rollback of §9 (S2a files, S2b
// `.crdt` bins): new image, where a tab types into a note by id → stop →
// export (refused while the server runs) → the image from before S2a, whose
// relay opens that note from the exported bin with the same text and no
// duplicate → agent and collab edits, a rename, a delete and a restore →
// graceful stop → new image, whose roll-forward merges the bins the old relay
// wrote (shared history, not set aside) → I2 (a revision at every seq), I4
// (files adopted or rendered, idle), no conflict copies, no duplicated typing.
import type { Check, LabTest } from '../lib/context.ts'
import { CollabClient, collabDocName } from '../lib/collab.ts'
import { dbNoteId } from '../lib/datapath.ts'
import { appExec, psql, psqlRows } from '../lib/docker.ts'
import { RestSession } from '../lib/rest.ts'
import { DATA, PRE_S2A_TAG, appImage, buildPreS2aImage, listFiles, runAppImage, runCli, stopApp, storeInvariants } from '../lib/store.ts'

const test: LabTest = {
  name: 'store-rollback',
  description: 'ADR-003 §9/§11: store-export-legacy (files and .crdt bins), old image edits (agent, collab, rename, restore), roll forward; I2/I4/I8.',
  async run(ctx) {
    const checks: Check[] = []
    const data: Record<string, unknown> = {}
    const newImage = (await appImage()).id
    await buildPreS2aImage()
    const mcp = ctx.mcp('adminAccount')
    const vault = await ctx.createVault('admin', ctx.uniq('rollback'))
    const V = vault.id
    for (let i = 0; i < 5; i++) await mcp.must('create_note', { vaultId: V, path: `docs/r-${i}`, body: `rollback note ${i}\n` })
    await mcp.must('create_note', { vaultId: V, path: 'docs/r-ordered', frontmatter: { type: 'docs', zeta: 1, alpha: 2 }, body: 'ordered\n' })
    await mcp.must('edit_note', { vaultId: V, path: 'docs/r-1', body: 'edited by the new image\n' })
    const admin = ctx.env.users.admin
    const sess = await RestSession.login(ctx.baseUrl, admin.email, admin.password)
    // A tab on the new image types into docs/r-0 by note id: the note gets CRDT state, which the export turns into a bin.
    const r0 = await dbNoteId(ctx, V, 'docs/r-0')
    const newMarker = `typed-on-new-${Date.now()}`
    const newTab = new CollabClient(ctx.baseUrl, collabDocName(V, r0), sess)
    const newConnected = await newTab.connect()
    checks.push({ name: 'new image: the editor connects by note id', expected: 'synced', actual: newConnected ? 'synced' : 'not synced', ok: newConnected ? true : null })
    if (newConnected) {
      newTab.type(`\n${newMarker}`)
      await newTab.waitAcked()
      await Bun.sleep(3_000) // the relay's debounced store (2 s)
    }
    newTab.destroy()

    try {
      // The export refuses to run next to a running server.
      const refused = await ctx.docker.appExec(['node', '--import', 'tsx', 'src/scripts/store-export-legacy.ts'])
      checks.push({
        name: 'export: refused while the server holds the instance lock',
        expected: 'exit 2 (maintenance lock)',
        actual: `exit ${refused.code}: ${(refused.stdout + refused.stderr).trim().slice(-200)}`,
        ok: refused.code === 2,
      })
      await stopApp()
      const exported = await runCli(['src/scripts/store-export-legacy.ts'])
      data.export = (exported.stdout + exported.stderr).trim().slice(-2000)
      checks.push({ name: 'export: completes with the server stopped', expected: 'exit 0', actual: `exit ${exported.code}`, ok: exported.code === 0 })
      // An incomplete export must not be followed by the old image (backup.md §5): stop here, as an operator would.
      if (exported.code !== 0) {
        return { summary: 'store-export-legacy did not complete; the old image was not started.', checks, data }
      }
      const conflictsBefore = (await listFiles(V, '.conflicts')).length

      // The old image: what old code does while rolled back.
      await runAppImage(ctx.baseUrl, PRE_S2A_TAG)
      const bins = await listFiles(V, '.crdt')
      checks.push({
        name: 'export: the note with CRDT state has its .crdt bin, in the layout the old relay reads',
        expected: 'docs/r-0.bin under .crdt/',
        actual: JSON.stringify(bins).slice(0, 300),
        ok: bins.includes('.crdt/docs/r-0.bin'),
      })
      await mcp.must('edit_note', { vaultId: V, path: 'docs/r-2', body: 'edited by the old image\n' })
      await mcp.must('rename_note', { vaultId: V, from: 'docs/r-3', toName: 'r-3-renamed' })
      const deleted = await mcp.must<{ id?: string }>('delete_note', { vaultId: V, path: 'docs/r-4' })
      const r4 = deleted.id ?? (await psql(`SELECT id FROM notes WHERE vault_id = '${V}' AND path = 'docs/r-4'`))
      await mcp.must('restore_note', { vaultId: V, noteId: r4 })
      // The old bundle names the document by path; the old relay loads it from the exported bin.
      const tab = new CollabClient(ctx.baseUrl, `${V}/docs/r-0`, sess)
      const connected = await tab.connect()
      checks.push({ name: 'old image: the editor connects', expected: 'synced', actual: connected ? 'synced' : 'not synced', ok: connected ? true : null })
      const marker = `typed-on-old-${Date.now()}`
      if (connected) {
        const rowOnOpen = (await psqlRows<{ body: string }>(`SELECT body FROM notes WHERE id = '${r0}'`))[0]?.body ?? ''
        checks.push({
          name: 'old image: the note opens from the exported bin with the row text, nothing doubled',
          expected: 'editor text = row, the new image typing once',
          actual: JSON.stringify({ same: tab.body === rowOnOpen, typed: tab.body.split(newMarker).length - 1 }),
          ok: tab.body === rowOnOpen && (!newConnected || tab.body.split(newMarker).length === 2),
        })
        tab.type(`\n${marker}`)
        await tab.waitAcked()
        await Bun.sleep(3_000)
      }
      tab.destroy()
      await stopApp()

      // Roll forward.
      await runAppImage(ctx.baseUrl, newImage)
      const rows = await psqlRows<{ path: string; body: string }>(`SELECT path, body FROM notes WHERE vault_id = '${V}' AND deleted_at IS NULL`)
      const bodyOf = (path: string) => rows.find((r) => r.path === path)?.body ?? ''
      const has = (name: string, ok: boolean, actual: unknown) =>
        checks.push({ name: `roll forward: ${name}`, expected: 'true', actual: JSON.stringify(actual).slice(0, 300), ok })
      has('the old image\'s agent edit is kept', bodyOf('docs/r-2') === 'edited by the old image\n', bodyOf('docs/r-2'))
      has('the old image\'s rename is kept', rows.some((r) => r.path === 'docs/r-3-renamed'), rows.map((r) => r.path))
      has('the old image\'s restore is kept', rows.some((r) => r.path === 'docs/r-4'), rows.map((r) => r.path))
      has('the new image\'s edit survived both switches', bodyOf('docs/r-1') === 'edited by the new image\n', bodyOf('docs/r-1'))
      if (connected) has('the collab typing is in the row exactly once', bodyOf('docs/r-0').split(marker).length === 2, bodyOf('docs/r-0'))
      if (newConnected) has('the new image typing is in the row exactly once', bodyOf('docs/r-0').split(newMarker).length === 2, bodyOf('docs/r-0'))
      // The roll-forward's report: the bin the old relay saved from the exported one shares its history, so it merged.
      const latest = await appExec(['sh', '-c', `ls -t ${DATA}/collab-migration-report-*.json 2>/dev/null | head -1 | xargs cat`])
      let report: { kind?: string; merged?: number; setAside?: Array<{ noteId: string; reason: string }> } = {}
      try {
        report = JSON.parse(latest.stdout)
      } catch {
        report = {}
      }
      data.rollForward = report
      has(
        'the bin the old relay wrote from the exported one merges (shared history), not set aside',
        report.kind === 'adr-003-collab-roll-forward' && !(report.setAside ?? []).some((s) => s.noteId === r0) && (report.merged ?? 0) >= 1,
        { kind: report.kind, merged: report.merged, setAside: report.setAside },
      )
      checks.push(...(await storeInvariants(V, 'after the roll forward', { conflictsBefore })))
    } finally {
      await runAppImage(ctx.baseUrl, newImage)
    }
    const failed = checks.filter((c) => c.ok === false).length
    return { summary: `${checks.length} checks, ${failed} failed.`, checks, data }
  },
}
export default test
