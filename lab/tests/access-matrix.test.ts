// The access-control matrix (lab/lib/access-matrix.ts) on a live instance,
// end to end over REST and MCP (#552, #1034). Server-suite counterpart:
// server/test/access-matrix.test.ts. The admin (owner) shares a vault and a
// local repository with the member (shared); a third user signed up here is
// the unrelated account. For every read surface that can name a note or a
// file: the owner and the shared account see it, the unrelated account
// never does, and after the revoke the shared account is refused with
// nothing identifying in the answer. The usage report is the #1034 class: a
// report must not list a read by its note's path once the share that
// allowed the read is gone.
import { mcpOutcome, restOutcome, runAccessMatrix, type AccessMatrix, type Actor, type ReadOutcome } from '../lib/access-matrix.ts'
import type { Check, LabTest } from '../lib/context.ts'
import { connectLocalRepo, copyIntoLocalRepo, settleRepo, writeTree } from '../lib/fixlab.ts'
import type { McpClient } from '../lib/mcp.ts'
import { poll } from '../lib/portability.ts'
import type { RestSession } from '../lib/rest.ts'

const test: LabTest = {
  name: 'access-matrix',
  tier: 'fast',
  description: 'Owner / shared / unrelated / revoked on every read surface that names a note or a file, REST and MCP, usage report included (#1034).',
  async run(ctx) {
    const checks: Check[] = []
    const data: Record<string, unknown> = {}
    const mark = `quokka${Date.now().toString(36)}`
    const target = `docs/${mark}-target`
    const source = `docs/${mark}-source`
    const file = `src/${mark}-plan.ts`

    // ------------------------------------------------------------ accounts
    const password = `Lab-${crypto.randomUUID()}`
    if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${password}`)
    const third = await ctx.signupUser(`${ctx.uniq('lab-matrix')}@example.com`, password)
    const thirdToken = await third.session.must<{ id: string; token: string }>('POST', '/api/mcp-connections', { name: 'lab access-matrix unrelated', scope: 'account' })
    const rest: Record<Actor, RestSession> = { owner: ctx.rest('admin'), shared: ctx.rest('member'), unrelated: third.session }
    const mcp: Record<Actor, McpClient> = { owner: ctx.mcp('adminAccount'), shared: ctx.mcp('memberAccount'), unrelated: ctx.mcp(thirdToken.token, 'matrix-unrelated') }
    const ids: Record<Actor, string> = { owner: ctx.env.users.admin.id, shared: ctx.env.users.member.id, unrelated: third.id }

    // ------------------------------------------------------------ fixtures
    const vaultId = (await ctx.createVault('admin', ctx.uniq('lab-matrix'))).id
    await mcp.owner.must('create_note', { vaultId, type: 'docs', name: `${mark}-target`, body: 'the target note' })
    const sourceNote = await mcp.owner.must<{ id: string }>('create_note', { vaultId, type: 'docs', name: `${mark}-source`, body: `${mark}source orbital checklist, see [[${target}]].` })
    const repoName = ctx.uniq('lab-matrix-repo')
    await copyIntoLocalRepo(ctx, writeTree({ [file]: `export const ${mark}Plan = 'launch window'\n` }), repoName)
    const repositoryId = (await connectLocalRepo(ctx, repoName)).id
    const repoSettle = await settleRepo(ctx, repositoryId, 'lab-matrix-repo', { stallMs: 60_000, timeoutMs: 240_000 })
    const embedded = await poll(async () => {
      const rows = await ctx.docker.psqlRows<{ n: number }>(
        `select count(*)::int as n from notes n where n.id = '${sourceNote.id}' and exists (select 1 from blocks b where b.owner_type = 'note' and b.owner_id = n.id and b.owner_version = n.seq::text and b.embedding is not null)`,
      )
      return rows[0]?.n === 1 ? true : undefined
    }, 240_000, 2_000)
    const fileRow = await rest.owner.get<{ id: string }>(`/api/repositories/${repositoryId}/files/content?path=${encodeURIComponent(file)}`)
    const fileId = fileRow.json?.id ?? ''
    data.fixtures = { vaultId, repositoryId, sourceId: sourceNote.id, fileId, repoSettle: repoSettle.outcome, embedded: embedded === true }

    // The usage report is on since aa-usage-report-on in a tier run; a filtered dispatch turns it on here and off again after.
    const setting = await rest.owner.get<{ enabled: boolean }>('/api/usage/settings')
    const reportWasOn = setting.json?.enabled === true
    if (!reportWasOn) await rest.owner.must('PUT', '/api/usage/settings', { enabled: true })

    // ------------------------------------------------------------ the matrix
    const share = async (): Promise<() => Promise<void>> => {
      const vaultShare = await rest.owner.must<{ id: string }>('POST', `/api/vaults/${vaultId}/shares`, { granteeType: 'user', granteeId: ids.shared, permission: 'read' })
      const repoShare = await rest.owner.must<{ id: string }>('POST', `/api/repositories/${repositoryId}/shares`, { granteeType: 'user', granteeId: ids.shared })
      return async () => {
        await rest.owner.must('DELETE', `/api/vaults/${vaultId}/shares/${vaultShare.id}`)
        await rest.owner.must('DELETE', `/api/repositories/${repositoryId}/shares/${repoShare.id}`)
      }
    }
    const viaMcp = (tool: string, args: Record<string, unknown>) => async (actor: Actor) => mcpOutcome(await mcp[actor].call(tool, args))
    const viaRest = (path: string) => async (actor: Actor) => restOutcome(await rest[actor].get(path))
    // A read, then a client-reported fallback, then the report: it lists the notes read just before the fallback by id and path.
    const readThenReport = (report: (actor: Actor) => Promise<ReadOutcome>) => async (actor: Actor) => {
      await mcp[actor].call('read_note', { vaultId, path: source })
      await fetch(`${ctx.baseUrl}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${mcp[actor].token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/elara/client_event', params: { event: 'local_fallback' } }),
      })
      return report(actor)
    }
    const matrices: AccessMatrix[] = [
      { name: 'MCP read_note', identifiers: [source, `${mark}source`], share, read: viaMcp('read_note', { vaultId, path: source }) },
      { name: 'REST GET /api/vaults/:id/notes/*', identifiers: [sourceNote.id, source, `${mark}source`], share, read: viaRest(`/api/vaults/${vaultId}/notes/${source}`) },
      { name: 'MCP read_file', identifiers: [file, `${mark}Plan`], share, read: viaMcp('read_file', { repositoryId, path: file }) },
      { name: 'REST GET /api/repositories/:id/files/content', identifiers: [file, `${mark}Plan`], share, read: viaRest(`/api/repositories/${repositoryId}/files/content?path=${encodeURIComponent(file)}`) },
      { name: 'MCP search in a vault', identifiers: [sourceNote.id, source], share, read: viaMcp('search', { vaultId, query: `${mark}source` }) },
      { name: 'MCP search everywhere', identifiers: [sourceNote.id, source], kind: 'listing', share, read: viaMcp('search', { everywhere: true, query: `${mark}source` }) },
      { name: 'REST GET /api/search (everywhere)', identifiers: [sourceNote.id, source], kind: 'listing', share, read: viaRest(`/api/search?q=${mark}source`) },
      { name: 'REST GET /api/vaults/:id/backlinks/*', identifiers: [sourceNote.id, source], share, read: viaRest(`/api/vaults/${vaultId}/backlinks/${target}`) },
      { name: 'MCP graph neighborsOf the target', identifiers: [source], share, read: viaMcp('graph', { vaultId, neighborsOf: target, edgeTypes: ['extracted'] }) },
      { name: 'MCP graph of a vault, every node', identifiers: [source, target], share, read: viaMcp('graph', { vaultId, aggregate: 'none' }) },
      { name: 'REST GET /api/vaults/:id/local-graph/*', identifiers: [sourceNote.id, source], share, read: viaRest(`/api/vaults/${vaultId}/local-graph/${target}?depth=1`) },
      { name: 'REST GET /api/usage/report', identifiers: [sourceNote.id, source], kind: 'listing', share, read: readThenReport(viaRest('/api/usage/report')) },
      { name: 'MCP usage_report', identifiers: [sourceNote.id, source], kind: 'listing', share, read: readThenReport(viaMcp('usage_report', {})) },
    ]
    for (const m of matrices) checks.push(...(await runAccessMatrix(m)))

    if (!reportWasOn) await rest.owner.must('PUT', '/api/usage/settings', { enabled: false })

    const failing = checks.filter((c) => c.ok !== true)
    const leaking = checks.filter((c) => c.actual.startsWith('LEAKS'))
    return {
      summary:
        `${matrices.length} read surfaces x 4 cases (owner, shared, unrelated, revoked): ${checks.length - failing.length} of ${checks.length} checks pass; ` +
        `${leaking.length} leak(s)${leaking.length ? `: ${leaking.map((c) => c.name).join('; ')}` : ''}; ` +
        `repository ${repoSettle.outcome}, note ${embedded ? 'embedded' : 'not embedded in time'}, usage report ${reportWasOn ? 'already on' : 'turned on here'}.`,
      checks,
      data,
    }
  },
}
export default test
