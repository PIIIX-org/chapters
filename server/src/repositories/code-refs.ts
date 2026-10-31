import {
  IMPACT_LEVEL_ROWS,
  MAX_DEFINITIONS,
  MAX_IMPACT_DEPTH,
  SITE_KINDS,
  codeSites,
  findDefinitions,
  impact,
  isSymbolId,
  symbolAt,
  type CodeSite,
  type Definition,
  type Target,
} from './code-queries.js'

/**
 * The answer to one code question (#470), the shape the MCP tool
 * (`find_symbols` with `refs`, mcp/code-queries.ts) and the REST route
 * (`GET /repositories/:id/code-refs`) share: `query` names a symbol (`parse`,
 * `Store.save`, or a symbol id), or for `at` is `path:line`. A row is
 * `{at: "path:line", in?: enclosing symbol, kind, confidence, context}`:
 * `kind` says why the row exists (`call`, `reference`, `import`, `test`),
 * `confidence` is `resolved` or `textual`. A name with several definitions
 * answers `candidates` and nothing else. Access to the repository is the
 * caller's to check.
 */
export const REFS = ['at', 'references', 'callers', 'impact', 'tests'] as const
export type Refs = (typeof REFS)[number]

export const DEFAULT_IMPACT_DEPTH = 2
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 50

export interface RefsArgs {
  query: string
  refs: Refs
  kind?: string
  path?: string
  depth?: number
  limit?: number
  /** Rows to skip in a list that pages (every one but `impact` and `candidates`). */
  offset?: number
}

/** A refused question: `INVALID_ARGUMENT` (the arguments) or `NOT_FOUND` (nothing is there). */
export class CodeQueryError extends Error {
  constructor(
    readonly code: 'INVALID_ARGUMENT' | 'NOT_FOUND',
    message: string,
    readonly field?: string,
  ) {
    super(message)
  }
}

/** A site as shown. `to`: past level 1 of `impact`, the symbol it names (`path#Class.method`); for `at`, what the line refers to. */
export interface Row {
  at: string
  in?: string
  kind: string
  confidence: string
  context: string
  to?: string
}

/** What a line of a file refers to, as shown. */
export interface LineSite {
  kind: string
  name: string
  confidence: string
  to?: string
}

/** A definition as `find_symbols` lists it: `name` bare, `parent` its class. */
export interface Described {
  id: string
  path: string
  name: string
  kind: string
  parent?: string
  line: number
}

export interface CodeList {
  name: string
  /** At most `limit` + 1: the last one only says that more exist. */
  rows: unknown[]
  /** Pages by `offset`: the list is long. Otherwise `limit` bounds it as a whole. */
  paged: boolean
}

export interface CodeAnswer {
  head: Record<string, unknown>
  lists: CodeList[]
  limit: number
}

const refused = (message: string, field: string) => new CodeQueryError('INVALID_ARGUMENT', message, field)

export const describe = (d: Definition): Described => ({
  id: d.id,
  path: d.path,
  name: d.name,
  kind: d.kind,
  ...(d.parent !== null ? { parent: d.parent } : {}),
  line: d.line,
})

const row = ({ path, line, symbol, kind, confidence, context, to }: CodeSite & { to?: string }): Row => ({
  at: `${path}:${line}`,
  ...(symbol !== null ? { in: symbol } : {}),
  kind,
  confidence,
  context,
  ...(to !== undefined ? { to } : {}),
})

/** Arguments that would be ignored are refused (as `graph` does, #426). */
export function checkRefsArguments(args: { refs?: Refs; path?: string; depth?: number; kind?: string }): void {
  if (args.refs === undefined) {
    if (args.path !== undefined) throw refused('`path` picks a definition for `refs`: pass both, or neither', 'path')
    if (args.depth !== undefined) throw refused('`depth` counts the levels of `refs: "impact"`: pass both, or neither', 'depth')
    return
  }
  if (args.depth !== undefined && args.refs !== 'impact') throw refused('`depth` goes with `refs: "impact"`', 'depth')
  if (args.refs === 'at' && (args.path !== undefined || args.kind !== undefined)) {
    throw refused('`refs: "at"` takes `query: "path:line"`: `path` and `kind` pick among definitions', args.path !== undefined ? 'path' : 'kind')
  }
}

/** The bare name of a symbol reference: `Store.save` is looked for as `save`. */
const bareName = (name: string) => name.slice(name.lastIndexOf('.') + 1)

export async function askCode(repositoryId: string, args: RefsArgs): Promise<CodeAnswer> {
  checkRefsArguments(args)
  const limit = args.limit ?? DEFAULT_LIMIT
  const offset = args.offset ?? 0

  if (args.refs === 'at') {
    const match = /^(.+):(\d+)$/.exec(args.query)
    if (!match || Number(match[2]) < 1) throw refused('`refs: "at"` takes `query: "path:line"`, e.g. `src/store.ts:42`', 'query')
    const [, path, line] = match as unknown as [string, string, string]
    const found = await symbolAt(repositoryId, path, Number(line), { limit: limit + 1, offset })
    if (found === null) throw new CodeQueryError('NOT_FOUND', `no file "${path}" in this repository`)
    const rows: LineSite[] = found.sites.map((s) => ({ kind: s.kind, name: s.name, confidence: s.confidence, ...(s.target ? { to: `${s.target.path}#${s.target.symbol}` } : {}) }))
    return {
      head: { refs: 'at', at: `${path}:${line}`, symbol: found.symbol ? describe(found.symbol) : null },
      lists: [{ name: 'results', rows, paged: true }],
      limit,
    }
  }

  const byId = isSymbolId(args.query)
  const definitions = await findDefinitions(repositoryId, { ...(byId ? { id: args.query } : { name: args.query }), path: args.path, kind: args.kind })
  if (definitions.length > 1) {
    return {
      head: { refs: args.refs, ...(definitions.length > MAX_DEFINITIONS ? { matches: definitions.length } : {}) },
      lists: [{ name: 'candidates', rows: definitions.slice(0, MAX_DEFINITIONS).map(describe), paged: false }],
      limit: MAX_DEFINITIONS,
    }
  }
  // A definition, or only a name: nothing defines it here, something names it.
  const definition = definitions[0] ?? null
  if (definition === null && (byId || args.path !== undefined || args.kind !== undefined)) {
    throw new CodeQueryError('NOT_FOUND', `no symbol "${args.query}" matches${args.path !== undefined ? ` in ${args.path}` : ''}`)
  }
  const target: Target = definition ?? { fileId: null, blockIds: [], name: bareName(args.query), symbol: args.query }
  const symbol = definition ? describe(definition) : { name: target.name }
  const nothing = () => new CodeQueryError('NOT_FOUND', `no symbol "${args.query}" here: nothing defines or names it`)

  if (args.refs === 'impact') {
    const depth = Math.min(args.depth ?? DEFAULT_IMPACT_DEPTH, MAX_IMPACT_DEPTH)
    const levels = await impact(repositoryId, target, depth)
    if (definition === null && levels.length === 0) throw nothing()
    // Each level's number of sites: `">500"` when the level was cut at the rows read for it.
    const total = Object.fromEntries(levels.map((l, i) => [i + 1, l.capped ? `>${IMPACT_LEVEL_ROWS}` : l.total]))
    return {
      head: { refs: 'impact', symbol, depth, total },
      lists: Array.from({ length: depth }, (_, i) => ({ name: `depth${i + 1}`, rows: (levels[i]?.sites ?? []).slice(0, limit + 1).map(row), paged: false })),
      limit,
    }
  }

  const sites = await codeSites(repositoryId, target, SITE_KINDS[args.refs], { limit: limit + 1, offset })
  if (definition === null && offset === 0 && sites.length === 0) throw nothing()
  return { head: { refs: args.refs, symbol }, lists: [{ name: 'results', rows: sites.map(row), paged: true }], limit }
}

/** The query string of `GET /repositories/:id/code-refs`: the arguments of `askCode`, `query` and `refs` required. */
export const codeRefsQuerySchema = {
  type: 'object',
  required: ['query', 'refs'],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 500 },
    refs: { type: 'string', enum: REFS },
    kind: { type: 'string', minLength: 1, maxLength: 40 },
    path: { type: 'string', minLength: 1, maxLength: 500 },
    depth: { type: 'integer', minimum: 1, maximum: MAX_IMPACT_DEPTH },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const

export type CodeRefsQuery = Omit<RefsArgs, 'refs'> & { refs: Refs }

/**
 * The REST answer: the head and each list's first `limit` rows under its
 * name; `next` is the `offset` that continues a list that pages, when more
 * rows exist (a list that does not page is complete up to `limit`: raise it).
 */
export async function codeRefsBody(repositoryId: string, args: RefsArgs): Promise<Record<string, unknown>> {
  const answer = await askCode(repositoryId, args)
  const body: Record<string, unknown> = { ...answer.head }
  for (const list of answer.lists) body[list.name] = list.rows.slice(0, answer.limit)
  const paged = answer.lists.find((l) => l.paged && l.rows.length > answer.limit)
  if (paged) body.next = (args.offset ?? 0) + answer.limit
  return body
}
