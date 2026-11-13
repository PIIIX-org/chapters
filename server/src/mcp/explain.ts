import { describe, indexedCodeQueries, type CodeQueries, type Row } from '../repositories/code-refs.js'
import { MAX_DEFINITIONS, SITE_KINDS, isSymbolId, type CodeSite, type Definition } from '../repositories/code-queries.js'
import { CITATION_ROWS, citationsOf, declarationOf } from '../repositories/explain.js'
import { bodyStartLine } from '../notes/projector.js'
import { McpToolError } from './errors.js'
import { folderOf, location, ranked, type Budgeted, type Ladder } from './response.js'

/** Entries of each list of an explanation: the first callers, tests and citing notes are what a question needs. */
const CALLERS = 5
const TESTS = 3
const CITES = 5

/** A site as `refs` shows it. */
const site = ({ path, line, symbol, kind, confidence, context }: CodeSite): Row => ({
  at: `${path}:${line}`,
  ...(symbol !== null ? { in: symbol } : {}),
  kind,
  confidence,
  context,
})

/** Sites down the ladder: without context, then `path:line`, counted per file. */
const SITES: Ladder<Row> = {
  no_context: (r) => ({ ...r, context: undefined }),
  locations: (r) => r.at,
  group: (r) => r.at.slice(0, r.at.lastIndexOf(':')),
}

interface Cite {
  vault: string
  at: string
  fresh: 'current' | 'stale' | 'unverified'
  context: string | null
}

/**
 * `find_symbols` with `refs: "explain"` (#675): where a symbol is, who calls it, which tests use it, which notes
 * cite its file and whether they are still current, in one answer that the response ladder packs into the budget.
 * `query` is a symbol (name or id) or `path:line` (the symbol around the line; the file alone between symbols).
 * `vaultIds` are the vaults the account may read: a repository-pinned token reads none, so has no `cites`.
 * Every location is `path#La-Lb` (a definition, a link in a note's file) or `path:line` (a site), at the `commit`
 * or `tree` in the head. A name with several definitions answers `candidates` only, as the other `refs` do.
 */
export async function explainAnswer(
  repositoryId: string,
  args: { query: string; kind?: string; path?: string },
  vaultIds: readonly string[],
  version: Record<string, unknown>,
  view?: CodeQueries & { declarationOf: typeof declarationOf },
): Promise<Budgeted> {
  const queries = view ?? indexedCodeQueries
  let definition: Definition | null
  let filePath: string
  const lineQuery = /^(.+):(\d+)$/.exec(args.query)
  if (lineQuery && !isSymbolId(args.query)) {
    if (args.path !== undefined || args.kind !== undefined) throw new McpToolError('INVALID_ARGUMENT', '`path:line` names its file: `path` and `kind` pick among definitions', { field: args.path !== undefined ? 'path' : 'kind' })
    filePath = lineQuery[1]!
    const found = await queries.symbolAt(repositoryId, filePath, Number(lineQuery[2]), { limit: 0, offset: 0 })
    if (found === null) throw new McpToolError('NOT_FOUND', `no file "${filePath}" in this repository`)
    definition = found.symbol
  } else {
    const found = await queries.findDefinitions(repositoryId, { ...(isSymbolId(args.query) ? { id: args.query } : { name: args.query }), path: args.path, kind: args.kind })
    if (found.length > 1) {
      return {
        head: { refs: 'explain', ...version, ...(found.length > MAX_DEFINITIONS ? { matches: found.length } : {}) },
        sections: [ranked({ name: 'candidates', items: found.slice(0, MAX_DEFINITIONS).map(describe), id: (c) => c.id, limit: MAX_DEFINITIONS })],
      }
    }
    if (found.length === 0) throw new McpToolError('NOT_FOUND', `no symbol "${args.query}" is defined here`)
    definition = found[0]!
    filePath = definition.path
  }

  const callers = definition ? await queries.codeSites(repositoryId, definition, SITE_KINDS.callers, { limit: CALLERS + 1, offset: 0 }, false) : []
  const tests = definition ? await queries.codeSites(repositoryId, definition, SITE_KINDS.tests, { limit: TESTS + 1, offset: 0 }) : []
  const cited = (await citationsOf(repositoryId, filePath, vaultIds)).slice(0, CITATION_ROWS)
  const starts = new Map<string, number>()
  const cites: Cite[] = cited.map((c) => {
    const key = `${c.vaultId}/${c.path}`
    if (c.startLine === 0) return { vault: c.vaultId, at: c.path, fresh: view ? 'unverified' : c.fresh ? 'current' : 'stale', context: c.context }
    let start = starts.get(key)
    if (start === undefined) starts.set(key, (start = bodyStartLine(c)))
    return { vault: c.vaultId, at: location(c.path, c.startLine + start - 1, c.endLine + start - 1), fresh: view ? 'unverified' : c.fresh ? 'current' : 'stale', context: c.context }
  })

  const declaration = definition ? await (view?.declarationOf ?? declarationOf)(definition.id) : null
  return {
    head: {
      refs: 'explain',
      ...version,
      symbol: definition
        ? { ...describe(definition), at: location(definition.path, definition.line, definition.endLine), ...(declaration ? { sig: declaration } : {}) }
        : { at: filePath },
    },
    sections: [
      ranked({ name: 'callers', items: callers.map(site), id: (r) => r.at, limit: CALLERS, ladder: SITES }),
      ranked({ name: 'tests', items: tests.map(site), id: (r) => r.at, limit: TESTS, ladder: SITES }),
      ranked({
        name: 'cites',
        items: cites,
        id: (c) => `${c.vault}:${c.at}`,
        limit: CITES,
        ladder: { no_context: (c) => ({ ...c, context: undefined }), locations: (c) => `${c.at} ${c.fresh}`, group: (c) => folderOf(c.at.split('#')[0]!) },
      }),
    ],
  }
}
