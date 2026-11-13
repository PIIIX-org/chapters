import { classifyQuery, MAX_ROUTED, routeTerm, type SearchRoute } from '../search/router.js'
import { classifyStructural, dispatchStructural, type StructuralSite, type StructuralTarget } from '../search/structural.js'
import { splitIdentifier } from '../search/identifiers.js'
import type { SearchResult } from '../search/search.js'
import { sliceLines, totalLines } from '../text/lines.js'
import type { Definition } from './code-queries.js'
import type { RepositoryView, ViewFile } from './ref-index.js'
import { viewQueries } from './ref-queries.js'

export type RefHit = Omit<SearchResult, 'updated'>
interface RefRouted {
  route: SearchRoute
  results: RefHit[]
  textual?: StructuralSite[]
  partial?: true
  confidence?: 1
  ambiguous?: true
}

/** Shared classifier/dispatcher, with lookups and graph queries bound exclusively to the selected view. */
export async function routeRef(view: RepositoryView, query: string, includeSymbols: boolean, override?: SearchRoute): Promise<{ attempted: SearchRoute; routed: RefRouted | null }> {
  const automatic = classifyQuery(query)
  const attempted = override ?? (automatic === 'identifier' && !includeSymbols ? 'conceptual' : automatic)
  if (attempted === 'conceptual') return { attempted, routed: null }
  let route = attempted
  const question = route === 'structural' ? classifyStructural(query) : null
  const term = question?.term ?? routeTerm(query)
  if (term === null || route === 'structural' && question === null) return { attempted, routed: null }
  const lower = term.toLowerCase()
  let targets: StructuralTarget[] | undefined
  if (route === 'path' || question?.kind === 'imports') {
    const files = [...view.files.values()].filter((f) => f.path.toLowerCase() === lower || f.path.toLowerCase().endsWith(`/${lower}`)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).slice(0, MAX_ROUTED + 1)
    if (files.length > MAX_ROUTED) return { attempted, routed: null }
    if (files.length === 1 && question?.kind === 'imports') {
      targets = [{ repositoryId: view.repositoryId, target: { wholeFile: true, fileId: files[0]!.id, blockIds: [], name: term, symbol: term } }]
    } else if (files.length) {
      const results = files.map((file): RefHit => {
        const lines = totalLines(file.content)
        return { resourceType: 'code', id: file.id, containerId: view.repositoryId, path: file.path, type: file.language, language: file.language, channel: 'exact', score: 1, snippet: file.content.slice(0, 200), ...(lines ? { startLine: 1, endLine: lines } : {}), tokens: Math.ceil(file.content.length / 4), outline: { symbols: file.structure.symbols.slice(0, 100).map((s) => ({ name: s.parent ? `${s.parent}.${s.name}` : s.name, kind: s.kind, startLine: s.startLine, endLine: s.endLine })), truncated: file.structure.symbols.length > 100 } }
      })
      return { attempted, routed: { route, results, ...(results.length === 1 ? { confidence: 1 } : { ambiguous: true }) } }
    } else if (route === 'path') {
      if (override !== undefined || term.includes('/')) return { attempted, routed: null }
      route = 'identifier'
    }
  }
  if (!includeSymbols && route !== 'structural') return { attempted, routed: null }
  const queries = viewQueries(view)
  if (!targets) {
    const split = splitIdentifier(term)
    const spellings = new Set([lower, split.whole, split.parts.join(''), split.parts.join('_'), split.parts.join('-')])
    const matched = new Map<string, Definition>()
    for (const definition of queries.definitions) {
      if (!spellings.has(definition.name.toLowerCase()) && !spellings.has(definition.symbol.toLowerCase())) continue
      const key = `${definition.path}\0${definition.symbol}`
      const held = matched.get(key)
      if (held) held.blockIds.push(...definition.blockIds)
      else matched.set(key, { ...definition, blockIds: [...definition.blockIds] })
      if (matched.size > MAX_ROUTED) return { attempted, routed: null }
    }
    const definitions = [...matched.values()]
    if (!definitions.length) return { attempted, routed: null }
    if (question && question.kind !== 'definition' && definitions.length === 1) targets = [{ repositoryId: view.repositoryId, target: definitions[0]! }]
    else {
      const results = definitions.map((d): RefHit => ({ resourceType: 'symbol', id: d.id, containerId: view.repositoryId, path: d.path, type: d.kind, symbolKind: d.kind, symbolName: d.name, ...(d.parent ? { symbolParent: d.parent } : {}), startLine: d.line, endLine: d.endLine, tokens: Math.ceil(sliceLines(view.files.get(d.path)!.content, d.line, d.endLine).length / 4), snippet: sliceLines(view.files.get(d.path)!.content, d.line, Math.min(d.endLine, d.line + 7)).slice(0, 200), channel: 'exact', score: 1 }))
      return { attempted, routed: { route, results, ...(results.length === 1 ? { confidence: 1 } : { ambiguous: true }) } }
    }
  }
  // The actual shared dispatcher never queries the current database through this injected adapter.
  const sites = await dispatchStructural(question!, targets, MAX_ROUTED, queries)
  const results: RefHit[] = sites.resolved.map((site) => {
    const file: ViewFile = view.files.get(site.path)!
    return { resourceType: 'code', id: file.id, containerId: view.repositoryId, path: file.path, type: file.language, language: file.language, ...(site.line === null ? {} : { startLine: site.line, endLine: site.line }), snippet: site.context, channel: 'exact', score: 1, edge: { kind: site.kind, confidence: 'resolved', symbol: site.symbol, col: site.col } }
  })
  return { attempted, routed: { route: 'structural', results, textual: sites.textual, ...(sites.partial ? { partial: true } : {}) } }
}
