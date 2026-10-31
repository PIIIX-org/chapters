// The opt-in usage report (#678), second of two (aa-usage-report-on turned
// it on first, so this run's calls were recorded): the report shows the
// run's numbers (calls and tokens per tool and per session, zero-result and
// unread-hit searches, notes never read, a client-reported fallback), no
// stored row holds a note's or a query's text, an account's report holds
// nothing of another account, and once turned off a call writes no row.
import type { Check, LabTest } from '../lib/context.ts'

type Json = Record<string, unknown>

const test: LabTest = {
  name: 'zzz-usage-report',
  tier: 'fast',
  description: 'Usage report after the run: numbers per tool/session/search, no stored text, accounts separated, off writes nothing (#678).',
  async run(ctx) {
    const checks: Check[] = []
    const admin = ctx.mcp('adminAccount')
    const vaultId = ctx.env.pinnedVaultId
    const mark = `usagelab${Date.now().toString(36)}`
    // A full-tier test that rebuilds the database (store-migration) takes the setting back to its default, off:
    // then this test turns it on again and the report covers what ran since. The fast tier keeps it on from aa-.
    const setting = await ctx.rest('admin').get<{ enabled: boolean }>('/api/usage/settings')
    const keptOn = setting.json?.enabled === true
    if (!keptOn) await ctx.rest('admin').must('PUT', '/api/usage/settings', { enabled: true })
    // A note no one reads, one that is found and read, a search with no result, and a fallback the client reports.
    await admin.must('create_note', { vaultId, type: 'docs', name: `${mark}-unread`, body: `${mark} unread body` })
    await admin.must('create_note', { vaultId, type: 'docs', name: `${mark}-read`, body: `${mark} read body` })
    await admin.must('search', { vaultId, query: `${mark}missing nothingmatches` })
    await admin.must('search', { vaultId, query: mark })
    await admin.must('read_note', { vaultId, path: `docs/${mark}-read` })
    const event = await fetch(`${ctx.baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.env.tokens.adminAccount.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/elara/client_event', params: { event: 'local_fallback' } }),
    })
    checks.push({ name: 'client_event notification accepted', expected: 'HTTP 202', actual: `HTTP ${event.status}`, ok: event.status === 202 })

    const instance = await ctx.rest('admin').get<Json>('/api/usage/report?scope=instance')
    const mine = await ctx.rest('admin').get<Json>('/api/usage/report')
    const theirs = await ctx.rest('member').get<Json>('/api/usage/report')
    const r = instance.json ?? {}
    const totals = (r.totals ?? {}) as { calls?: number; tokens?: number; errors?: number; zero_results?: number }
    const tools = (r.tools ?? []) as Array<{ tool: string; calls: number; tokens: number; latency_p95_ms: number | null }>
    const searches = (r.searches ?? {}) as { total?: number; zero_result?: number; with_hits?: number; no_useful_hit?: number }
    const sessions = (r.sessions ?? {}) as { count?: number }
    const neverRead = (r.never_read ?? {}) as { count?: number }
    const fallbacks = (r.fallbacks ?? {}) as { reported?: number; reads_before?: number }
    checks.push({ name: 'instance report', expected: 'HTTP 200, enabled', actual: `HTTP ${instance.status}, enabled ${String(r.enabled)}`, ok: instance.status === 200 && r.enabled === true })
    checks.push({ name: 'calls and tokens per tool', expected: '> 0 calls, > 1 tool', actual: `${totals.calls} calls, ${tools.length} tools`, ok: (totals.calls ?? 0) > 0 && tools.length > 1 })
    checks.push({ name: 'sessions', expected: '>= 1', actual: String(sessions.count), ok: (sessions.count ?? 0) >= 1 })
    checks.push({ name: 'zero-result searches counted', expected: '>= 1', actual: String(searches.zero_result), ok: (searches.zero_result ?? 0) >= 1 })
    checks.push({ name: 'notes never read counted', expected: '>= 1', actual: String(neverRead.count), ok: (neverRead.count ?? 0) >= 1 })
    // The read is recorded by the note's id (the never-read list shows the first 50 by path; the lab's vault holds more).
    const readsOf = async (name: string) =>
      Number(await ctx.docker.psql(`SELECT count(*) FROM usage_events e JOIN notes n ON n.id = e.target_id WHERE n.vault_id = '${vaultId}' AND n.path = 'docs/${name}'`))
    const [readCount, unreadCount] = [await readsOf(`${mark}-read`), await readsOf(`${mark}-unread`)]
    const mineNever = (mine.json?.never_read ?? {}) as { count?: number }
    checks.push({
      name: 'reads recorded by note id; the unread note counted as never read',
      expected: 'read note 1 read, unread note 0, account never_read >= 1',
      actual: `read note ${readCount}, unread note ${unreadCount}, account never_read ${mineNever.count}`,
      ok: mine.status === 200 && readCount === 1 && unreadCount === 0 && (mineNever.count ?? 0) >= 1,
    })
    checks.push({
      name: "member report holds nothing of the admin's notes",
      expected: `no ${mark}`,
      actual: theirs.status === 200 ? (theirs.text.includes(mark) ? `contains ${mark}` : 'none') : `HTTP ${theirs.status}`,
      ok: theirs.status === 200 && !theirs.text.includes(mark),
    })
    checks.push({
      name: 'instance report holds no path, account or note text',
      expected: `no ${mark}, no account id`,
      actual: [mark, ctx.env.users.admin.id, ctx.env.users.member.id].filter((s) => instance.text.includes(s)).join(', ') || 'none',
      ok: ![mark, ctx.env.users.admin.id, ctx.env.users.member.id].some((s) => instance.text.includes(s)),
    })
    // The rows themselves (the report wrote everything queued before it answered).
    const stored = Number(await ctx.docker.psql(`SELECT count(*) FROM usage_events e WHERE row_to_json(e)::text LIKE '%${mark}%'`))
    const rows = Number(await ctx.docker.psql('SELECT count(*) FROM usage_events'))
    checks.push({ name: 'no stored row holds note or query text', expected: `0 of ${rows} rows contain ${mark}`, actual: `${stored} of ${rows}`, ok: rows > 0 && stored === 0 })

    // Off again: a call writes nothing.
    const off = await ctx.rest('admin').request('PUT', '/api/usage/settings', { enabled: false })
    await admin.must('search', { vaultId, query: mark })
    await ctx.rest('admin').get('/api/usage/report')
    const after = Number(await ctx.docker.psql('SELECT count(*) FROM usage_events'))
    checks.push({ name: 'off: a call writes no row', expected: `HTTP 200, ${rows} rows`, actual: `HTTP ${off.status}, ${after} rows`, ok: off.status === 200 && after === rows })

    const top = [...tools].sort((a, b) => b.tokens - a.tokens).slice(0, 5).map((t) => `${t.tool} ${t.calls} calls/${Math.round(t.tokens)} tokens`)
    return {
      summary:
        `Usage report for this run (instance scope${keptOn ? ', on since aa-usage-report-on' : ', turned on again here: an earlier test reset the database'}): ` +
        `${totals.calls} calls, ${Math.round(totals.tokens ?? 0)} response tokens, ${totals.errors} errors over ${tools.length} tools ` +
        `(top by tokens: ${top.join('; ')}); ${sessions.count} sessions; searches ${searches.total} (${searches.zero_result} with no result, ` +
        `${searches.with_hits} with hits, ${searches.no_useful_hit} of them with no hit read in the next 5 calls); ${neverRead.count} live notes never read; ` +
        `${fallbacks.reported} client-reported fallback(s), ${fallbacks.reads_before} read(s) just before.`,
      checks,
      // The instance report: aggregates only (no account, note id or path; queries as salted hashes).
      data: { instance: r },
    }
  },
}
export default test
