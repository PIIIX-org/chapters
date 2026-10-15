// Sanity check of the lab itself, and the smallest example of a lab test:
// every bootstrap token authenticates, lists tools, and a revoked/unknown
// token is refused.
import type { Check, LabTest, TokenKey } from '../lib/context.ts'
import { McpClient } from '../lib/mcp.ts'

const test: LabTest = {
  name: 'smoke',
  tier: 'fast',
  description: 'Bootstrap tokens authenticate; tools/list per scope; unknown token rejected.',
  async run(ctx) {
    const checks: Check[] = []
    const toolCounts: Record<string, number> = {}
    for (const key of Object.keys(ctx.env.tokens) as TokenKey[]) {
      const tools = await ctx.mcp(key).listTools()
      toolCounts[key] = tools.length
      checks.push({ name: `${key} tools/list`, expected: '> 0 tools', actual: `${tools.length} tools`, ok: tools.length > 0 })
    }
    const bogus = await new McpClient(ctx.baseUrl, 'not-a-token', 'bogus').call('list_vaults')
    checks.push({
      name: 'unknown token',
      expected: 'HTTP 401',
      actual: `HTTP ${bogus.httpStatus}`,
      ok: bogus.httpStatus === 401,
    })
    const me = await ctx.rest('member').get<{ email: string }>('/api/me')
    checks.push({ name: 'member session', expected: '200', actual: String(me.status), ok: me.status === 200 })
    return {
      summary: `tools/list sizes per token: ${JSON.stringify(toolCounts)}.`,
      checks,
      data: { toolCounts },
    }
  },
}
export default test
