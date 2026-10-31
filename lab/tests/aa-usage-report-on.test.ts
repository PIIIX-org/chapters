// The opt-in usage report (#678), first of two: on a fresh instance it is
// off, a member cannot turn it on, and the instance admin turns it on, so
// the rest of the run is recorded. zzz-usage-report.test.ts (last in file
// order) reads the report the run produced and turns it off again.
import type { Check, LabTest } from '../lib/context.ts'

const test: LabTest = {
  name: 'aa-usage-report-on',
  tier: 'fast',
  description: 'Usage report: off on a fresh instance, admin-only toggle, turned on for the rest of the run (#678).',
  async run(ctx) {
    const checks: Check[] = []
    const before = await ctx.rest('admin').get<{ enabled: boolean }>('/api/usage/settings')
    checks.push({
      name: 'off by default',
      expected: '200 {"enabled":false}',
      actual: `${before.status} ${before.text.slice(0, 200)}`,
      ok: before.status === 200 && before.json?.enabled === false,
    })
    const member = await ctx.rest('member').request('PUT', '/api/usage/settings', { enabled: true })
    checks.push({ name: 'a member cannot turn it on', expected: 'HTTP 403', actual: `HTTP ${member.status}`, ok: member.status === 403 })
    const on = await ctx.rest('admin').request<{ enabled: boolean }>('PUT', '/api/usage/settings', { enabled: true })
    checks.push({
      name: 'the instance admin turns it on',
      expected: '200 {"enabled":true}',
      actual: `${on.status} ${on.text.slice(0, 200)}`,
      ok: on.status === 200 && on.json?.enabled === true,
    })
    return {
      summary: `Usage report ${on.json?.enabled === true ? 'on' : 'NOT on'} for the rest of this run (was ${before.json?.enabled === false ? 'off' : 'not off'} by default).`,
      checks,
    }
  },
}
export default test
