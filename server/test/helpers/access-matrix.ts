// The access-control matrix every read surface passes (#1034 leak class,
// docs/agents/lab.md "Access-control matrix"). For one read surface (a REST
// route or an MCP tool) and one object an owner shares with a second account:
//
//   owner      the owner's read answers and names the object;
//   shared     the shared account's read answers and names it;
//   unrelated  an account the object was never shared with never sees it
//              (while the share is live, so the share widens to nobody else);
//   revoked    after the owner revokes the share, the shared account is
//              refused (NOT_FOUND / 403, an `object` surface) or answered
//              without it (a `listing` surface such as the usage report), and
//              no identifying field (path, id, title, body) is in the answer,
//              error text included.
//
// `accessMatrix` registers the four cases as `it` blocks of one `describe`,
// in that order, so a file lists one matrix per surface.
import { beforeAll, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'

export type Actor = 'owner' | 'shared' | 'unrelated'

/** What one read answered, as the matrix judges it. */
export interface ReadOutcome {
  /** The surface answered (HTTP 2xx, or an MCP result that is not an error). */
  ok: boolean
  /** Refused for access: HTTP 403 or 404, or an MCP NOT_FOUND / PERMISSION_REQUIRED / FORBIDDEN error. */
  denied: boolean
  /** The whole answer: body or error, as text. */
  text: string
}

export interface MatrixFixture {
  /** Strings that identify the object (path, id, title, a body marker): every one in the owner's and the shared account's answer, none in the others. */
  identifiers: string[]
  /** Takes the share away; called once, before the `revoked` case. */
  revoke: () => Promise<void>
  /**
   * `object` (default): a read of the object itself, which the revoked and the
   * unrelated account are refused. `listing`: a surface that answers everyone
   * (a search across every reachable vault, the usage report) and must just
   * not mention the object.
   */
  kind?: 'object' | 'listing'
}

export interface AccessMatrix {
  /** Creates the object and the share; returns what identifies it and how to revoke. Runs once, in `beforeAll`. */
  setup: () => Promise<MatrixFixture>
  /** The read, as `actor`. */
  read: (actor: Actor) => Promise<ReadOutcome>
}

const DENIED_CODES = /"code":"(NOT_FOUND|PERMISSION_REQUIRED|FORBIDDEN)"/

/** A REST answer (`app.inject`) as a ReadOutcome. */
export function restOutcome(res: LightMyRequestResponse): ReadOutcome {
  return { ok: res.statusCode >= 200 && res.statusCode < 300, denied: res.statusCode === 403 || res.statusCode === 404, text: res.body }
}

/** An MCP tool answer (`client.callTool`) as a ReadOutcome: the error envelope's code decides `denied` (#439). */
export function mcpOutcome(result: Record<string, unknown>): ReadOutcome {
  const content = Array.isArray(result.content) ? result.content : []
  const text = content
    .map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : ''))
    .join('')
  const isError = result.isError === true
  return { ok: !isError, denied: isError && DENIED_CODES.test(text), text }
}

export function accessMatrix(name: string, matrix: AccessMatrix): void {
  describe(`access matrix: ${name}`, () => {
    let fx: MatrixFixture
    beforeAll(async () => {
      fx = await matrix.setup()
      expect(fx.identifiers.length, 'a matrix needs at least one identifier').toBeGreaterThan(0)
    })

    const sees = async (actor: Actor) => {
      const r = await matrix.read(actor)
      expect(r.ok, `${actor}: ${r.text.slice(0, 300)}`).toBe(true)
      for (const id of fx.identifiers) expect(r.text, `${actor} does not see ${id}`).toContain(id)
    }

    const hidden = async (actor: Actor) => {
      const r = await matrix.read(actor)
      if ((fx.kind ?? 'object') === 'object') expect(r.denied, `${actor}: expected NOT_FOUND/403, got ${r.text.slice(0, 300)}`).toBe(true)
      else expect(r.ok, `${actor}: ${r.text.slice(0, 300)}`).toBe(true)
      expect(fx.identifiers.filter((id) => r.text.includes(id)), `${actor}: leaked in ${r.text.slice(0, 300)}`).toEqual([])
    }

    it('the owner sees it', () => sees('owner'))
    it('the shared account sees it', () => sees('shared'))
    it('an unrelated account never sees it', () => hidden('unrelated'))
    it('after the revoke the shared account is refused and nothing identifying leaks', async () => {
      await fx.revoke()
      await hidden('shared')
    })
  })
}
