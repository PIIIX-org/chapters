import { RefError, viewId, type RepositoryView } from './ref-index.js'
import type { CodeQueries } from './code-refs.js'
import { IMPACT_FRONTIER, IMPACT_LEVEL_ROWS, MAX_IMPACT_DEPTH, SITE_KINDS, type CodeSite, type Definition, type ImpactLevel, type Target } from './code-queries.js'
import { codeEdgeDrafts, isTestPath, type CodeEdgeDraft } from './code-edges.js'
import { buildResolutionContext, resolveImportPath } from './import-resolution.js'
import { ORIENT_ENTRIES, type OrientOptions, type OrientOffsets, type OrientFolder, type OrientSymbol } from './orient.js'

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const inner = (s: { name: string; parent?: string }) => s.parent ? `${s.parent}.${s.name}` : s.name
const directory = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
interface Edge extends CodeSite {
  name: string
  qualified: string | null
  member: boolean
  external: boolean
  target: Definition | null
  source: Definition | null
}
const siteOrder = (a: CodeSite, b: CodeSite) => Number(b.confidence === 'resolved') - Number(a.confidence === 'resolved') || compare(a.path, b.path) || a.line - b.line || a.col - b.col || compare(a.kind, b.kind)
const site = ({ path, line, col, kind, symbol, confidence, context }: Edge): CodeSite => ({ path, line, col, kind, symbol, confidence, context })
const names = (edge: Edge, target: Target) => edge.target !== null
  ? edge.target.fileId === target.fileId && edge.target.blockIds.some((id) => target.blockIds.includes(id))
  : edge.name === target.name && (edge.qualified === null || edge.qualified === target.symbol)

/** Edges are resolved again after overlay application, including unchanged importers of changed/deleted files. */
export function viewQueries(view: RepositoryView): CodeQueries & {
  definitions: Definition[]
  declarationOf: (id: string) => Promise<string | null>
  repositoryMap: (repositoryId: string, opts: OrientOptions, offsets?: OrientOffsets) => Promise<{ symbols: OrientSymbol[]; folders: OrientFolder[] }>
} {
  const definitions: Definition[] = []
  const byBlock = new Map<string, Definition>()
  const byName = new Map<string, Definition[]>()
  const byFile = new Map<string, Definition[]>()
  for (const f of view.files.values()) {
    for (const b of f.blocks.filter((b) => b.kind === 'symbol')) {
      const symbol = f.structure.symbols.find((s) => s.startLine === b.startLine && inner(s) === b.innerPath)!
      const definition: Definition = { id: viewId(`${f.id}\0${b.blockId}`), fileId: f.id, blockIds: [b.blockId], path: f.path, name: symbol.name, symbol: b.innerPath, kind: b.symbolKind!, parent: b.symbolParent, line: b.startLine, endLine: b.endLine }
      definitions.push(definition)
      byBlock.set(b.blockId, definition)
      const named = byName.get(definition.name) ?? []
      named.push(definition)
      byName.set(definition.name, named)
      const filed = byFile.get(f.path) ?? []
      filed.push(definition)
      byFile.set(f.path, filed)
    }
  }
  definitions.sort((a, b) => compare(a.path, b.path) || compare(a.symbol, b.symbol) || a.line - b.line || compare(a.id, b.id))
  const paths = new Set(view.files.keys())
  const context = buildResolutionContext(view.files.values())
  const edges: Edge[] = []
  const moduleImports: Array<CodeSite & { targetFileId: string }> = []
  const single = (found: Definition[]) => found.length > 0 && found.every((d) => d.fileId === found[0]!.fileId && d.symbol === found[0]!.symbol) ? found[0]! : null
  for (const f of view.files.values()) {
    const imports = new Map(f.structure.imports.map((i) => [i.target, resolveImportPath(f.path, i.target, paths, context)]))
    const lines = f.content.split('\n')
    for (const imported of f.structure.imports) {
      const destination = view.files.get(imports.get(imported.target) ?? '')
      if (destination) moduleImports.push({ path: f.path, line: imported.line, col: 1, kind: 'import', confidence: 'resolved', symbol: null, context: lines[imported.line - 1]!.trim().slice(0, 160), targetFileId: destination.id })
    }
    const blocks = f.blocks.filter((b) => b.kind === 'symbol')
    const { drafts, note } = codeEdgeDrafts(f.path, f.content, blocks, f.structure.sites)
    // A cap may not make a removed call look absent. Fail the view instead of returning an incomplete graph.
    if (note) throw new RefError('BUSY', note)
    const resolveEdge = (draft: CodeEdgeDraft): { target: Definition | null; confidence: Edge['confidence'] } => {
      if (draft.local !== null) return { target: byBlock.get(draft.local) ?? null, confidence: 'resolved' }
      const named = byName.get(draft.name) ?? []
      const scoped = (d: Definition) => d.fileId !== f.id && d.symbol === (draft.qualified ?? draft.name)
      let found: Definition | null = null
      if (!draft.member) {
        const targets = draft.via !== null ? [imports.get(draft.via)] : ['c', 'cpp', 'ruby', 'php'].includes(f.language ?? '') ? [...imports.values()] : []
        found = single(named.filter((d) => targets.includes(d.path) && scoped(d)))
        if (!found && draft.via === null && ['go', 'java'].includes(f.language ?? '')) found = single(named.filter((d) => view.files.get(d.path)!.language === f.language && directory(d.path) === directory(f.path) && scoped(d)))
      }
      if (found) return { target: found, confidence: 'resolved' }
      found = (draft.qualified === null ? null : single(named.filter((d) => d.symbol === draft.qualified))) ?? single(named)
      return { target: found, confidence: 'textual' }
    }
    for (const draft of drafts) {
      const resolved = resolveEdge(draft)
      const source = draft.sourceBlockId === null ? null : byBlock.get(draft.sourceBlockId) ?? null
      edges.push({ path: f.path, line: draft.line, col: draft.col, kind: draft.kind, context: draft.context, symbol: source?.symbol ?? null, source, name: draft.name, qualified: draft.qualified, member: draft.member, ...resolved,
        external: resolved.confidence === 'textual' && draft.via !== null && ['typescript', 'javascript'].includes(f.language ?? '') && !imports.get(draft.via),
      })
    }
  }
  edges.sort(siteOrder)
  const callers = (target: Target, kinds: readonly string[], members: boolean) => edges.filter((e) => !e.external && (members || !(e.confidence === 'textual' && e.member)) && kinds.includes(e.kind) && names(e, target))
  const queries: CodeQueries = {
    async findDefinitions(_repositoryId, ref) {
      const found = definitions.filter((d) => (ref.id !== undefined ? d.id === ref.id || d.blockIds.includes(ref.id) : d.name === ref.name || d.symbol === ref.name) && (ref.path === undefined || d.path === ref.path) && (ref.kind === undefined || d.kind === ref.kind)).slice(0, 1_000)
      const grouped: Definition[] = []
      for (const d of found) {
        const last = grouped.at(-1)
        if (last && last.fileId === d.fileId && last.symbol === d.symbol) last.blockIds.push(...d.blockIds)
        else grouped.push({ ...d, blockIds: [...d.blockIds] })
      }
      return grouped
    },
    async symbolAt(_repositoryId, path, line, page) {
      if (!view.files.has(path)) return null
      const symbol = (byFile.get(path) ?? []).filter((d) => d.line <= line && d.endLine >= line).sort((a, b) => a.endLine - a.line - (b.endLine - b.line) || b.line - a.line)[0] ?? null
      const found = edges.filter((e) => e.path === path && e.line === line).sort((a, b) => a.col - b.col || compare(a.kind, b.kind)).slice(page.offset, page.offset + page.limit)
      return { symbol, sites: found.map((e) => ({ kind: e.kind, confidence: e.confidence, name: e.name, target: e.target ? { path: e.target.path, symbol: e.target.symbol, line: e.target.line } : null })) }
    },
    async codeSites(_repositoryId, target, kinds, page, members = true) {
      if (target.wholeFile) return kinds.includes('import')
        ? moduleImports.filter((i) => i.targetFileId === target.fileId).sort(siteOrder).slice(page.offset, page.offset + page.limit).map(({ path, line, col, kind, confidence, symbol, context }) => ({ path, line, col, kind, confidence, symbol, context }))
        : []
      return callers(target, kinds, members).slice(page.offset, page.offset + page.limit).map(site)
    },
    async impact(_repositoryId, target, depth) {
      const levels: ImpactLevel[] = []
      const visited = new Set(definitions.filter((d) => d.fileId === target.fileId && d.blockIds.some((b) => target.blockIds.includes(b))).map((d) => d.id))
      let frontier = new Map<string, { definition: Definition; confidence: Edge['confidence'] }>()
      let frontierCut = false
      for (let level = 1; level <= Math.min(depth, MAX_IMPACT_DEPTH); level++) {
        const all = level === 1 ? callers(target, SITE_KINDS.dependents, false) : edges.filter((e) => !e.external && SITE_KINDS.dependents.some((k) => k === e.kind) && e.confidence === 'resolved' && e.target !== null && frontier.has(e.target.id) && (e.source === null || !visited.has(e.source.id)))
        if (all.length === 0) break
        const rows = all.slice(0, IMPACT_LEVEL_ROWS)
        const next = new Map<string, { definition: Definition; confidence: Edge['confidence'] }>()
        const sites = rows.map((e) => {
          const via = level === 1 || !e.target ? undefined : frontier.get(e.target.id)
          const confidence = e.confidence === 'resolved' && (!via || via.confidence === 'resolved') ? 'resolved' as const : 'textual' as const
          if (e.source && (!next.has(e.source.id) || confidence === 'resolved')) next.set(e.source.id, { definition: e.source, confidence })
          return { ...site(e), confidence, ...(via ? { to: `${via.definition.path}#${via.definition.symbol}` } : {}) }
        }).sort(siteOrder)
        levels.push({ sites, total: rows.length, capped: all.length > IMPACT_LEVEL_ROWS || frontierCut })
        frontierCut = next.size > IMPACT_FRONTIER
        frontier = new Map([...next].slice(0, IMPACT_FRONTIER))
        for (const id of next.keys()) visited.add(id)
      }
      return levels
    },
  }
  return {
    ...queries,
    definitions,
    async declarationOf(id) {
      const d = definitions.find((s) => s.id === id)
      return d ? view.files.get(d.path)!.content.split('\n')[d.line - 1]!.trim() : null
    },
    async repositoryMap(_repositoryId, opts, offsets = {}) {
      const prefix = opts.folder ? `${opts.folder}/` : ''
      const focus = opts.focus ?? []
      const focused = (path: string) => focus.some((f) => path === f || path.startsWith(`${f.replace(/\/$/, '')}/`))
      const words = (opts.query ?? '').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean).slice(0, 8)
      const scored = definitions.filter((d) => d.path.startsWith(prefix) && !isTestPath(d.path)).map((d) => {
        const uses = edges.filter((e) => e.target?.id === d.id && e.path !== d.path && !isTestPath(e.path) && e.kind !== 'test' && (e.confidence === 'resolved' || !e.member))
        const refs = uses.filter((e) => e.confidence === 'resolved').length
        const guessed = uses.length - refs
        const score = refs + 0.5 * guessed + 5 * uses.filter((e) => e.confidence === 'resolved' && focused(e.path)).length + (focused(d.path) ? 20 : 0) + (words.some((w) => d.symbol.toLowerCase().includes(w)) ? 10 : 0) + (words.some((w) => d.path.toLowerCase().includes(w)) ? 5 : 0)
        return { d, refs, guessed, score }
      }).sort((a, b) => b.score - a.score || compare(a.d.path, b.d.path) || a.d.line - b.d.line)
      const groups = new Map<string, { files: Set<string>; refs: number; score: number }>()
      for (const row of scored) {
        const suffix = row.d.path.slice(prefix.length)
        const child = prefix + suffix.split('/')[0]! + (suffix.includes('/') ? '/' : '')
        const group = groups.get(child) ?? { files: new Set(), refs: 0, score: 0 }
        group.files.add(row.d.path)
        group.refs += row.refs
        group.score += row.score
        groups.set(child, group)
      }
      return {
        folders: [...groups].sort((a, b) => b[1].score - a[1].score || compare(a[0], b[0])).slice(0, ORIENT_ENTRIES + 1).map(([path, g]) => ({ path, files: g.files.size, refs: g.refs })),
        symbols: scored.slice(offsets.symbols ?? 0, (offsets.symbols ?? 0) + ORIENT_ENTRIES + 1).map(({ d, refs, guessed }) => ({ at: `${d.path}:${d.line}`, kind: d.kind, symbol: d.symbol, sig: view.files.get(d.path)!.content.split('\n')[d.line - 1]!.trim(), refs, ...(guessed ? { guessed } : {}) })),
      }
    },
  }
}
