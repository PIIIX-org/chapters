import { config } from '../config.js'
import { embedder, embedQuery, EMBEDDER_ID } from '../search/embeddings.js'
import { CHUNK_VERSION, embedKey } from '../search/embed-key.js'
import { vectorsInAccount } from './blob-cache.js'
import { RefError, type RepositoryView, type ViewFile } from './ref-index.js'
import type { CodeBlock } from './code-blocks.js'

type VectorMap = Map<string, readonly number[]>
const vectors = new WeakMap<ViewFile, { version: string; result: VectorMap }>()
const indexes = new WeakMap<RepositoryView['files'], { version: string; result: Promise<VectorMap> }>()
export const refSearchStats = { embedded: 0, reused: 0 }
interface Hit {
  id: string
  path: string
  name?: string
  kind?: string
  parent?: string
  startLine?: number
  endLine?: number
  snippet: string
  score: number
}
async function viewVectors(view: RepositoryView): Promise<VectorMap> {
  const version = `${EMBEDDER_ID}:${CHUNK_VERSION}:${config.embedMaxSymbolsPerFile}`
  const held = indexes.get(view.files)
  if (held?.version === version) return held.result
  const result = (async () => {
    const found: VectorMap = new Map()
    const pending = new Map<ViewFile, Map<string, string>>()
    const texts = new Map<string, string>()
    for (const file of view.files.values()) {
      const cached = vectors.get(file)
      if (cached?.version === version) {
        for (const [id, vector] of cached.result) found.set(id, vector)
        refSearchStats.reused += cached.result.size
        continue
      }
      const ordered = file.blocks.flatMap((b, i) => b.budgetTier === null ? [] : [{ i, tier: b.budgetTier }]).sort((a, b) => a.tier - b.tier)
      const budgeted = new Set(ordered.slice(0, config.embedMaxSymbolsPerFile).map((b) => b.i))
      const keys = new Map<string, string>()
      for (const [i, block] of file.blocks.entries()) {
        if (block.kind === 'section' || !(budgeted.has(i) || block.budgetTier === null && (block.outlineOf === undefined || budgeted.has(block.outlineOf)))) continue
        const key = embedKey(block.embedText)
        keys.set(block.blockId, key)
        texts.set(key, block.embedText)
      }
      pending.set(file, keys)
    }
    if (texts.size > 50_000) throw new RefError('BUSY', 'ref exceeds the bounded embedding work budget')
    // One account-scoped SQL lookup for the whole tree, not one lookup per file.
    const reused = await vectorsInAccount(view.repositoryId, [...texts.keys()])
    const missing = [...texts].filter(([key]) => !reused.has(key))
    const embedded = new Map<string, readonly number[]>()
    for (let i = 0; i < missing.length; i += 32) {
      const batch = missing.slice(i, i + 32)
      const values = await embedder.embed(batch.map(([, text]) => text))
      if (values.length !== batch.length) throw new RefError('BUSY', 'ref embedding did not complete')
      batch.forEach(([key], index) => embedded.set(key, values[index]!))
      refSearchStats.embedded += batch.length
    }
    for (const [file, keys] of pending) {
      const fileResult: VectorMap = new Map()
      for (const [id, key] of keys) {
        const vector = reused.get(key) ?? embedded.get(key)!
        found.set(id, vector)
        fileResult.set(id, vector)
        if (reused.has(key)) refSearchStats.reused++
      }
      vectors.set(file, { version, result: fileResult })
    }
    return found
  })()
  indexes.set(view.files, { version, result })
  try { return await result } catch (err) { indexes.delete(view.files); throw err }
}
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! * a[i]!; bb += b[i]! * b[i]! }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}
const compare = (a: Hit, b: Hit) => a.path < b.path ? -1 : a.path > b.path ? 1 : (a.startLine ?? 0) - (b.startLine ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Both channels use the selected tree's bytes; nothing is searched in the default index as a substitute. */
export async function searchRef(view: RepositoryView, accountId: string, args: { query: string; kind?: string; limit?: number; symbols?: boolean }, symbolsOnly: boolean): Promise<Hit[]> {
  if (args.query.length > 2_000) throw new RefError('INVALID_ARGUMENT', 'query is at most 2000 characters', 'query')
  const words = args.query.toLowerCase().split(/[^\p{L}\p{N}_.]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).slice(0, 32)
  if (!words.length) return []
  let query: readonly number[]
  try { query = await embedQuery(args.query, accountId) } catch { throw new RefError('BUSY', 'query embedding is unavailable') }
  let embedded: VectorMap
  try { embedded = await viewVectors(view) } catch (err) { throw err instanceof RefError ? err : new RefError('BUSY', 'ref embedding is unavailable') }
  const candidates = new Map<string, { hit: Hit; keyword: number; vector: number }>()
  for (const f of view.files.values()) {
    const selected = f.blocks.filter((b) => symbolsOnly ? b.kind === 'symbol' : b.kind === 'file' || b.kind === 'skeleton' || args.symbols !== false && b.kind === 'symbol')
    for (const b of selected) {
      if (args.kind !== undefined && b.symbolKind !== args.kind) continue
      const text = `${b.innerPath} ${f.path} ${b.snippet ?? f.content}`.toLowerCase()
      const matched = words.every((w) => text.includes(w))
      const keyword = matched ? (b.innerPath.toLowerCase() === args.query.toLowerCase() ? 100 : b.kind === 'symbol' ? 10 : 1) : 0
      const vector = embedded.get(b.blockId)
      const similarity = vector ? cosine(query, vector) : -1
      if (!keyword && 1 - similarity > config.searchMaxDistance) continue
      const symbol = b.kind === 'symbol' ? f.structure.symbols.find((s) => s.startLine === b.startLine && (s.parent ? `${s.parent}.${s.name}` : s.name) === b.innerPath) : null
      const hit = hitOf(f, b, symbol?.name)
      const candidate = { hit, keyword, vector: 1 - similarity <= config.searchMaxDistance ? similarity : -1 }
      const previous = candidates.get(hit.id)
      if (!previous) candidates.set(hit.id, candidate)
      else candidates.set(hit.id, { hit: candidate.vector > previous.vector ? hit : previous.hit, keyword: Math.max(keyword, previous.keyword), vector: Math.max(candidate.vector, previous.vector) })
    }
  }
  const ranked = [...candidates.values()]
  const scores = new Map<string, number>()
  const lexical = ranked.filter((c) => c.keyword > 0).sort((a, b) => b.keyword - a.keyword || compare(a.hit, b.hit)).slice(0, 100)
  const semantic = ranked.filter((c) => c.vector >= -0.000001).sort((a, b) => b.vector - a.vector || compare(a.hit, b.hit)).slice(0, 100)
  for (const channel of [lexical, semantic]) channel.forEach((c, i) => scores.set(c.hit.id, (scores.get(c.hit.id) ?? 0) + 1 / (60 + i + 1)))
  return ranked.filter((c) => scores.has(c.hit.id)).map((c) => ({ ...c.hit, score: scores.get(c.hit.id)! + (c.keyword === 100 ? 1 : 0) })).sort((a, b) => b.score - a.score || compare(a, b)).slice(0, (args.limit ?? 20) + 1)
}
function hitOf(file: ViewFile, b: CodeBlock, name: string | undefined): Hit {
  return { id: name ? b.blockId : file.id, path: file.path, ...(name ? { name, kind: b.symbolKind!, ...(b.symbolParent ? { parent: b.symbolParent } : {}) } : {}), ...(b.endLine >= b.startLine ? { startLine: b.startLine, endLine: b.endLine } : {}), snippet: b.snippet ?? file.content.slice(0, 1500), score: 0 }
}
