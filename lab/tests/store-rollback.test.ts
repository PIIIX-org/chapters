// ADR-003 §11 store-rollback, the code-only rollback of §9 for S2a:
// new image → `store-export-legacy` (refused while the server runs) → stop →
// export → the image from before S2a → agent and collab edits, a rename, a
// delete and a restore → graceful stop → new image → I2 (a revision at
// every seq), I4 (files adopted or rendered, idle), no conflict copies, no
// duplicated typing.
import type { Check, LabTest } from '../lib/context.ts'
import { CollabClient } from '../lib/collab.ts'
import { psql, psqlRows } from '../lib/docker.ts'
import { RestSession } from '../lib/rest.ts'
import { PRE_S2A_TAG, appImage, buildPreS2aImage, listFiles, runAppImage, runCli, stopApp, storeInvariants } from '../lib/store.ts'

const test: LabTest = {
  name: 'store-rollback',
  description: 'ADR-003 §9/§11: store-export-legacy, old image edits (agent, collab, rename, restore), roll forward; I2/I4/I8.',
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
      await mcp.must('edit_note', { vaultId: V, path: 'docs/r-2', body: 'edited by the old image\n' })
      await mcp.must('rename_note', { vaultId: V, from: 'docs/r-3', toName: 'r-3-renamed' })
      const deleted = await mcp.must<{ id?: string }>('delete_note', { vaultId: V, path: 'docs/r-4' })
      const r4 = deleted.id ?? (await psql(`SELECT id FROM notes WHERE vault_id = '${V}' AND path = 'docs/r-4'`))
      await mcp.must('restore_note', { vaultId: V, noteId: r4 })
      const admin = ctx.env.users.admin
      const sess = await RestSession.login(ctx.baseUrl, admin.email, admin.password)
      const tab = new CollabClient(ctx.baseUrl, `${V}/docs/r-0`, sess)
      const connected = await tab.connect()
      checks.push({ name: 'old image: the editor connects', expected: 'synced', actual: connected ? 'synced' : 'not synced', ok: connected ? true : null })
      const marker = `typed-on-old-${Date.now()}`
      if (connected) {
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
      checks.push(...(await storeInvariants(V, 'after the roll forward', { conflictsBefore })))
    } finally {
      await runAppImage(ctx.baseUrl, newImage)
    }
    const failed = checks.filter((c) => c.ok === false).length
    return { summary: `${checks.length} checks, ${failed} failed.`, checks, data }
  },
}
export default test
