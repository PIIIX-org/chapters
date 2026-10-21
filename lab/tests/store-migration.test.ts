// ADR-003 §11 store-migration: the S2a backfill against data written by the
// image from before S2a.
//
// 1. Run the pre-S2a image (lab/lib/store.ts PRE_S2A_REF) on this instance's
//    database and volume, with the store bookkeeping reset to what an
//    instance that never ran S2a has (no store_migrated_at, no projection
//    or projected_files rows).
// 2. Make every damage class S2a's backfill classifies: SIGKILL in the middle
//    of old-code writes, an unparseable file, a file that differs from its
//    row (hand edit: the file wins, Q5), a hand-formatted file with the same
//    content (adopted, bytes kept), a row changed by SQL without a revision,
//    an orphan temp file.
// 3. Start the new image: assert the report's counts, I2/I4/I5, unchanged
//    bytes for files already in serializeNote form, and the Q5 outcome.
// 4. Reset the bookkeeping again and rerun the backfill with a SIGKILL at
//    `migration.mid-batch`: the final state equals the uninterrupted run.
// Not covered here (S2b): stale `.crdt` bins and a tab holding old items.
import type { Check, LabTest } from '../lib/context.ts'
import { psql, psqlRows } from '../lib/docker.ts'
import {
  DATA,
  PRE_S2A_TAG,
  appImage,
  buildPreS2aImage,
  recreateApp,
  runAppImage,
  stopApp,
  storeInvariants,
} from '../lib/store.ts'

const RESET_STORE = `
  UPDATE instance_state SET store_migrated_at = NULL;
  DELETE FROM projected_files;
  DELETE FROM note_projections;`

const test: LabTest = {
  name: 'store-migration',
  description: 'ADR-003 §11: S2a backfill over pre-S2a data with every damage class; then a SIGKILL at migration.mid-batch ends in the same state.',
  async run(ctx) {
    const checks: Check[] = []
    const data: Record<string, unknown> = {}
    const exec = (cmd: string) => ctx.docker.appExec(['sh', '-c', cmd])
    const newImage = (await appImage()).id
    await buildPreS2aImage()
    try {
      // 1. The old image, on bookkeeping from before S2a.
      await runAppImage(ctx.baseUrl, PRE_S2A_TAG)
      await psql(RESET_STORE)
      const mcp = ctx.mcp('adminAccount')
      const vault = await ctx.createVault('admin', ctx.uniq('migration'))
      const V = vault.id
      const root = `${DATA}/vaults/${V}`
      const create = (path: string, body: string, frontmatter?: Record<string, unknown>) =>
        mcp.must<{ id: string }>('create_note', { vaultId: V, path, body, ...(frontmatter ? { frontmatter } : {}) })

      // 2. Damage classes.
      for (let i = 0; i < 12; i++) await create(`docs/plain-${i}`, `plain note ${i}\n`)
      await create('docs/unparseable', 'row text\n')
      await create('docs/hand-edit', 'row text\n')
      await create('docs/hand-format', 'same content\n', { type: 'docs', title: 'Formatted' })
      await create('docs/sql-changed', 'before sql\n')
      // A SIGKILL while old code writes (no transaction): rows and files may diverge.
      const edits = Array.from({ length: 12 }, (_, i) => mcp.call('edit_note', { vaultId: V, path: `docs/plain-${i}`, body: `edited ${i}\n` }, 30_000))
      await Bun.sleep(150)
      data.crash = await ctx.docker.app.crash(ctx.baseUrl)
      await Promise.allSettled(edits)
      await exec(`printf -- '---\\ntype: [unclosed\\n---\\nbroken\\n' > ${root}/docs/unparseable.md`)
      await exec(`printf -- '---\\ntype: docs\\n---\\nedited by hand\\n' > ${root}/docs/hand-edit.md`)
      await exec(`printf -- "---\\ntitle: 'Formatted'\\ntype:   docs\\n---\\nsame content\\n" > ${root}/docs/hand-format.md`)
      await psql(`UPDATE notes SET body = 'after sql\n' WHERE vault_id = '${V}' AND path = 'docs/sql-changed'`)
      await exec(`printf 'partial' > ${root}/docs/plain-0.md.4242.abcdefabcdef.tmp`)
      const shaFiles = async () =>
        (await exec(`cd ${root} && find docs -name '*.md' | sort | xargs sha256sum`)).stdout.trim()
      const handFormatBefore = (await exec(`sha256sum ${root}/docs/hand-format.md`)).stdout.split(' ')[0]
      await stopApp()

      // 3. The new image runs the backfill at boot.
      await runAppImage(ctx.baseUrl, newImage)
      const report = JSON.parse(
        (await exec(`cat "$(ls -1t ${DATA}/migration-report-*.json | head -1)"`)).stdout || '{}',
      ) as {
        file?: Record<string, number>
        projection?: Record<string, number>
        conflicts?: Array<{ path: string }>
        failed?: unknown[]
        tempFilesRemoved?: number
      }
      data.report = report
      const has = (name: string, ok: boolean, actual: unknown) =>
        checks.push({ name: `migration: ${name}`, expected: 'true', actual: JSON.stringify(actual).slice(0, 300), ok })
      has('the report lists an unparseable file', (report.file?.unparseable ?? 0) >= 1, report.file)
      has('the report lists the hand edit as a file-wins conflict', (report.conflicts ?? []).some((c) => c.path === 'docs/hand-edit.md'), report.conflicts)
      has('the report adopts the hand-formatted file', (report.projection?.adopted ?? 0) >= 1, report.projection)
      has('the orphan temp file was removed', (report.tempFilesRemoved ?? 0) >= 1, report.tempFilesRemoved)
      has('no note failed', (report.failed ?? []).length === 0, report.failed)
      const rows = await psqlRows<{ path: string; body: string }>(`SELECT path, body FROM notes WHERE vault_id = '${V}' AND deleted_at IS NULL`)
      const bodyOf = (path: string) => rows.find((r) => r.path === path)?.body
      has('Q5: the hand-edited file wins', bodyOf('docs/hand-edit') === 'edited by hand\n', bodyOf('docs/hand-edit'))
      has('the row of the unparseable file is kept', bodyOf('docs/unparseable') === 'row text\n', bodyOf('docs/unparseable'))
      has(
        'the hand-formatted file keeps its bytes (adopted)',
        (await exec(`sha256sum ${root}/docs/hand-format.md`)).stdout.split(' ')[0] === handFormatBefore,
        handFormatBefore,
      )
      const rowKept = await psql(`
        SELECT count(*) FROM note_revisions r JOIN notes n ON n.id = r.note_id
        WHERE n.vault_id = '${V}' AND n.path = 'docs/hand-edit' AND r.action = 'migration:row-kept'`)
      has('Q5: the row text is kept as a migration:row-kept revision', rowKept === '1', rowKept)
      checks.push(...(await storeInvariants(V, 'after the backfill')))

      // 4. Rerun with a SIGKILL after the first note of a batch.
      const settled = { rows: await psql(`SELECT md5(string_agg(id || seq || body || frontmatter::text, ',' ORDER BY id)) FROM notes WHERE vault_id = '${V}'`), files: await shaFiles() }
      const revisions = await psql(`SELECT count(*) FROM note_revisions r JOIN notes n ON n.id = r.note_id WHERE n.vault_id = '${V}'`)
      await stopApp()
      await psql(RESET_STORE)
      await recreateApp(ctx.baseUrl, 'migration.mid-batch', false)
      await Bun.sleep(5_000)
      await recreateApp(ctx.baseUrl, '')
      const again = { rows: await psql(`SELECT md5(string_agg(id || seq || body || frontmatter::text, ',' ORDER BY id)) FROM notes WHERE vault_id = '${V}'`), files: await shaFiles() }
      checks.push({ name: 'mid-batch: rows equal the uninterrupted run', expected: settled.rows, actual: again.rows, ok: again.rows === settled.rows })
      checks.push({ name: 'mid-batch: note files equal the uninterrupted run', expected: 'same sha256 list', actual: again.files === settled.files ? 'same' : 'differs', ok: again.files === settled.files })
      const revisionsAgain = await psql(`SELECT count(*) FROM note_revisions r JOIN notes n ON n.id = r.note_id WHERE n.vault_id = '${V}'`)
      checks.push({ name: 'mid-batch: no revision added by the rerun', expected: revisions, actual: revisionsAgain, ok: revisionsAgain === revisions })
      checks.push(...(await storeInvariants(V, 'after the interrupted rerun')))
    } finally {
      // Leave the instance on the image under test, inert and healthy.
      await runAppImage(ctx.baseUrl, newImage)
    }
    const failed = checks.filter((c) => c.ok === false).length
    return { summary: `${checks.length} checks, ${failed} failed.`, checks, data }
  },
}
export default test
