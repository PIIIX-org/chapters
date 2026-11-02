/**
 * Routing hints (#674): when the request has a shape another tool answers
 * more cheaply, the answer carries one short `hint` (a field of its head, so
 * `structuredContent` has it too) saying what to use and why. A pure function
 * of the request shape: no answer, clock or index state, so the same call has
 * the same hint. A hint never replaces or shortens an answer: Elara cannot
 * know whether the caller has a checkout, so the answer stays and the hint
 * comes with it, and only when a rule below applies.
 *
 * Rules:
 * - `search` over exactly one repository (no vault) with a query that is
 *   literal text, not meaning or a name: a quoted string, or code punctuation
 *   that natural language and identifiers lack. In a checked-out repository,
 *   `rg` finds every occurrence and is not a ranking. Elara is the right tool
 *   across repositories and for notes, so a search that reaches a vault or
 *   several repositories never gets this hint.
 * - `read_file` / `read_note` of a long text read from the top without
 *   `targets` or `outline`: the outline and then the part wanted cost less
 *   than every page.
 */

/** A longer text read whole is worth the outline hint. */
export const LONG_TEXT_LINES = 400
/** A query longer than this is prose, not a string to look up. */
const MAX_LITERAL = 80

export type RoutingRequest =
  | { tool: 'search'; query: string; vaults: number; repositories: number }
  | { tool: 'read_file' | 'read_note'; lines: number; targets: boolean; outline: boolean; continued: boolean }

export function routingHint(req: RoutingRequest): string | undefined {
  if (req.tool === 'search') {
    if (req.vaults !== 0 || req.repositories !== 1) return undefined
    const query = req.query.trim()
    if (query === '' || query.length > MAX_LITERAL || /[\r\n]/.test(query)) return undefined
    const quoted = /^(["'`]).+\1$/.test(query)
    const code = /[(){}[\]<>=;\\|^$*+]|::|->/.test(query)
    if (!quoted && !code) return undefined
    const literal = quoted ? query.slice(1, -1) : query
    return `exact text, not meaning: in a checked-out repo \`rg -n -F ${JSON.stringify(literal)}\` lists every occurrence for less than a ranked search`
  }
  if (req.targets || req.outline || req.continued || req.lines <= LONG_TEXT_LINES) return undefined
  return `${req.lines} lines: \`outline: true\`, then \`targets\`, cost less than every page`
}
