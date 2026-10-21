// ADR-003 §11: deterministic SIGKILL boundaries of the S2a store. For each
// failpoint (server/src/failpoints.ts) the app is recreated with
// ELARA_FAILPOINTS=<name>, the operation that reaches the point runs, the
// process kills itself there, the app is recreated inert, and the vault is
// checked: I1 (the write is in the row exactly when it committed), I2, I4
// (check-notes --wait-idle --fail-on-pending), I5 and the operation's own
// effect (refactor resumed, trash file removed, file projected).
// crash-write's timing sweep stays as the randomised complement.
import type { Check, LabTest } from '../lib/context.ts'
import { psql } from '../lib/docker.ts'
import { DATA, appProcess, listFiles, recreateApp, storeInvariants, waitAppKilled } from '../lib/store.ts'

interface Case {
  point: string
  /** Prepares the notes the operation needs (app inert). */
  setup(): Promise<void>
  /** The operation that reaches the failpoint; its answer is not awaited for correctness. */
  op(): Promise<unknown>
  /** I1 and the operation's effect after the restart. */
  verify(): Promise<Check[]>
}

const test: LabTest = {
  name: 'store-failpoints',
  description: 'ADR-003 §11 failpoints: SIGKILL at each store boundary (ELARA_FAILPOINTS), restart, I1/I2/I4/I5 and the effect of the operation.',
  async run(ctx) {
    const checks: Check[] = []
    const data: Record<string, unknown> = {}
    const mcp = ctx.mcp('adminAccount')
    const vault = await ctx.createVault('admin', ctx.uniq('failpoints'))
    const V = vault.id
    const body = async (path: string) => psql(`SELECT body FROM notes WHERE vault_id = '${V}' AND path = '${path}' AND deleted_at IS NULL`)
    const create = (path: string, text: string) => mcp.must<{ id: string }>('create_note', { vaultId: V, path, body: text })
    const fileOf = async (rel: string) => (await ctx.docker.appExec(['cat', `${DATA}/vaults/${V}/${rel}`])).stdout
    const same = (name: string, expected: string, actual: string): Check => ({ name, expected, actual: actual.slice(0, 200), ok: actual === expected })

    let purgeId = ''
    const cases: Case[] = [
      {
        point: 'edit.before-commit',
        setup: async () => void (await create('docs/fp-before', 'old')),
        op: () => mcp.call('edit_note', { vaultId: V, path: 'docs/fp-before', body: 'new' }, 20_000),
        verify: async () => [same('edit.before-commit: I1 nothing committed, the row keeps the old body', 'old', await body('docs/fp-before'))],
      },
      {
        point: 'edit.after-commit-before-ack',
        setup: async () => void (await create('docs/fp-ack', 'old')),
        op: () => mcp.call('edit_note', { vaultId: V, path: 'docs/fp-ack', body: 'new' }, 20_000),
        verify: async () => [same('edit.after-commit-before-ack: I1 the committed write is in the row', 'new', await body('docs/fp-ack'))],
      },
      {
        point: 'edit.after-commit-before-live-apply',
        setup: async () => void (await create('docs/fp-live', 'old')),
        op: () => mcp.call('edit_note', { vaultId: V, path: 'docs/fp-live', body: 'new' }, 20_000),
        verify: async () => [same('edit.after-commit-before-live-apply: I1 the committed write is in the row', 'new', await body('docs/fp-live'))],
      },
      {
        point: 'create.after-commit-before-file',
        setup: async () => {},
        op: () => mcp.call('create_note', { vaultId: V, path: 'docs/fp-create', body: 'created' }, 20_000),
        verify: async () => [
          same('create.after-commit-before-file: I1 the row exists', 'created', await body('docs/fp-create')),
          same('create.after-commit-before-file: the projector wrote the file after the restart', 'true', String((await fileOf('docs/fp-create.md')).includes('created'))),
        ],
      },
      {
        point: 'projector.after-tmp-before-rename',
        setup: async () => void (await create('docs/fp-tmp', 'old')),
        op: () => mcp.call('edit_note', { vaultId: V, path: 'docs/fp-tmp', body: 'new' }, 20_000),
        verify: async () => [
          same('projector.after-tmp-before-rename: I1 the row holds the write', 'new', await body('docs/fp-tmp')),
          same('projector.after-tmp-before-rename: the file holds the write after the restart', 'true', String((await fileOf('docs/fp-tmp.md')).includes('new'))),
        ],
      },
      {
        point: 'projector.after-rename-before-mark',
        setup: async () => void (await create('docs/fp-mark', 'old')),
        op: () => mcp.call('edit_note', { vaultId: V, path: 'docs/fp-mark', body: 'new' }, 20_000),
        verify: async () => [
          same('projector.after-rename-before-mark: I1 the row holds the write', 'new', await body('docs/fp-mark')),
          same('projector.after-rename-before-mark: no conflict copy (the file is the projector\'s own)', '0', String((await listFiles(V, '.conflicts')).filter((f) => f.includes('fp-mark')).length)),
        ],
      },
      {
        point: 'rename.after-commit-before-refactor',
        setup: async () => {
          await create('docs/fp-target', 'target')
          await create('docs/fp-referrer', 'see [[docs/fp-target]]')
        },
        op: () => mcp.call('rename_note', { vaultId: V, from: 'docs/fp-target', toName: 'fp-renamed' }, 20_000),
        verify: async () => [
          same('rename.after-commit-before-refactor: I1 the note moved', 'target', await body('docs/fp-renamed')),
          same('rename.after-commit-before-refactor: the referrer refactor resumed after the restart', 'see [[docs/fp-renamed]]', await body('docs/fp-referrer')),
        ],
      },
      {
        point: 'purge.after-commit-before-remove',
        setup: async () => {
          purgeId = (await create('docs/fp-purge', 'purged')).id
          await mcp.must('delete_note', { vaultId: V, path: 'docs/fp-purge' })
        },
        op: () => mcp.call('purge_note', { vaultId: V, noteId: purgeId }, 20_000),
        verify: async () => [
          same('purge.after-commit-before-remove: I1 the row is gone', '0', await psql(`SELECT count(*) FROM notes WHERE id = '${purgeId}'`)),
          same('purge.after-commit-before-remove: the trash file is removed after the restart', 'false', String((await listFiles(V, '.trash')).includes(`.trash/${purgeId}.md`))),
        ],
      },
    ]

    try {
      for (const c of cases) {
        await c.setup()
        await ctx.docker.appExec(['node', '--import', 'tsx', 'src/scripts/check-notes.ts', '--vault', V, '--wait-idle=60'])
        await recreateApp(ctx.baseUrl, c.point)
        const before = await appProcess()
        const answer = await c.op()
        const killed = await waitAppKilled(before)
        checks.push({ name: `${c.point}: the process SIGKILLed itself at the failpoint`, expected: 'killed', actual: killed ? 'killed' : 'still running', ok: killed })
        await recreateApp(ctx.baseUrl, '')
        checks.push(...(await c.verify()))
        checks.push(...(await storeInvariants(V, c.point)))
        data[c.point] = { killed, answer }
      }
    } finally {
      // Leave the instance inert and healthy for the next test.
      await recreateApp(ctx.baseUrl, '')
    }
    const failed = checks.filter((c) => c.ok === false).length
    return { summary: `${cases.length} failpoints, ${checks.length} checks, ${failed} failed.`, checks, data }
  },
}
export default test
