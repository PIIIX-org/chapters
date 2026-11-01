// The access-control matrix on a live instance: the lab's copy of
// server/test/helpers/access-matrix.ts (docs/agents/lab.md "Access-control
// matrix"). For one read surface and one object an owner shares with a
// second account it reports four checks:
//
//   owner      the owner's read answers and names the object;
//   shared     the shared account's read answers and names it;
//   unrelated  an account the object was never shared with never sees it
//              (probed while the share is live);
//   revoked    after the owner revokes the share, the shared account is
//              refused (NOT_FOUND / 403 on an `object` surface) or answered
//              without it (a `listing` surface), and nothing identifying is
//              in the answer, error text included.
import type { Check } from './context.ts'
import type { ToolResult } from './mcp.ts'
import type { RestResponse } from './rest.ts'

export type Actor = 'owner' | 'shared' | 'unrelated'

export interface ReadOutcome {
  /** The surface answered (HTTP 2xx, or an MCP result that is not an error). */
  ok: boolean
  /** Refused for access: HTTP 403 or 404, or an MCP NOT_FOUND / PERMISSION_REQUIRED / FORBIDDEN error. */
  denied: boolean
  text: string
}

export interface AccessMatrix {
  /** Names the surface in the four check names: keep it free of run-specific values. */
  name: string
  /** Strings that identify the object (path, id, a body marker): every one in the owner's and the shared account's answer, none in the others. */
  identifiers: string[]
  /** `object` (default): the revoked and the unrelated account are refused. `listing`: the surface answers everyone and must just not mention the object. */
  kind?: 'object' | 'listing'
  /** Grants the share; resolves to the revoke. */
  share: () => Promise<() => Promise<void>>
  read: (actor: Actor) => Promise<ReadOutcome>
}

const DENIED_CODES = /"code":"(NOT_FOUND|PERMISSION_REQUIRED|FORBIDDEN)"/

export function restOutcome(r: RestResponse): ReadOutcome {
  return { ok: r.status >= 200 && r.status < 300, denied: r.status === 403 || r.status === 404, text: `HTTP ${r.status} ${r.text}` }
}

export function mcpOutcome(r: ToolResult): ReadOutcome {
  return { ok: r.ok, denied: r.httpStatus === 403 || r.httpStatus === 404 || (r.isError && DENIED_CODES.test(r.text)), text: r.text }
}

export async function runAccessMatrix(m: AccessMatrix): Promise<Check[]> {
  const checks: Check[] = []
  const revoke = await m.share()
  const sees = async (actor: Actor, name: string): Promise<void> => {
    const r = await m.read(actor)
    const missing = m.identifiers.filter((id) => !r.text.includes(id))
    checks.push({
      name: `${m.name}: ${name}`,
      expected: `answers and names the object (${m.identifiers.length} identifier(s))`,
      actual: r.ok ? (missing.length ? `answers without ${missing.length} identifier(s)` : 'answers and names it') : `refused: ${r.text.slice(0, 160)}`,
      ok: r.ok ? missing.length === 0 : null,
      severity: 'high',
    })
  }
  const hidden = async (actor: Actor, name: string): Promise<void> => {
    const r = await m.read(actor)
    const leaks = m.identifiers.filter((id) => r.text.includes(id))
    const refusal = (m.kind ?? 'object') === 'object' ? r.denied : r.ok
    checks.push({
      name: `${m.name}: ${name}`,
      expected: (m.kind ?? 'object') === 'object' ? 'NOT_FOUND or 403, no identifying field in the answer' : 'answers without any identifying field',
      actual: leaks.length ? `LEAKS ${leaks.length} identifier(s): ${r.text.slice(0, 160)}` : refusal ? 'nothing identifying' : `unexpected answer: ${r.text.slice(0, 160)}`,
      ok: leaks.length === 0 && refusal,
      severity: leaks.length ? 'critical' : 'high',
    })
  }
  await sees('owner', 'the owner sees it')
  await sees('shared', 'the shared account sees it')
  await hidden('unrelated', 'an unrelated account never sees it')
  await revoke()
  await hidden('shared', 'after the revoke the shared account is refused and nothing identifying leaks')
  return checks
}
