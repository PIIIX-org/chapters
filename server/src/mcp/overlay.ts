import { OverlayError, overlaySymbols, parseOverlay, type FilePatch } from '../repositories/overlay.js'
import type { SymbolSearchResult } from '../search/search.js'
import { McpToolError } from './errors.js'

/** What the base search is asked for beyond the page: hits in the overlay's files are dropped, so some are spare. */
export const OVERLAY_SPARE = 50

/** The overlay's patches, or the tool's refusal naming `overlay`. */
export function readOverlay(diff: string): FilePatch[] {
  try {
    return parseOverlay(diff)
  } catch (err) {
    if (err instanceof OverlayError) throw new McpToolError('INVALID_ARGUMENT', err.message, { field: 'overlay' })
    throw err
  }
}

export type OverlayResult = Omit<SymbolSearchResult, 'fileId'> & { fileId: string | null }

/**
 * `find_symbols` on base + overlay (#676): the base hits outside the overlay's files, with the symbols the overlay's
 * added and modified files declare that match `query` (every word in the symbol's name or path, `kind` when given;
 * lexical, not the hybrid ranking). Order: the overlay's symbols first (named exactly `query`, then the others by
 * path and line: what the agent's edit declares is what it asks about, and base hits must not push it out), then the
 * base hits in their order. A file the overlay deletes or changes has none of its indexed hits, so a
 * symbol the overlay removes is not found. Overlay hits have no `fileId` (the file is not indexed so) and the id
 * `overlay:<path>:<line>:<name>`. Nothing is stored. `limit` is the length of the answer.
 */
export async function overlayHits(
  repositoryId: string,
  patches: readonly FilePatch[],
  query: string,
  base: readonly SymbolSearchResult[],
  opts: { kind?: string; limit: number },
): Promise<{ hits: OverlayResult[]; skipped: string[]; stale: string[] }> {
  let found
  try {
    found = await overlaySymbols(repositoryId, patches)
  } catch (err) {
    if (err instanceof OverlayError) throw new McpToolError('INVALID_ARGUMENT', err.message, { field: 'overlay' })
    throw err
  }
  const wanted = query.toLowerCase()
  // A word has a letter or digit: a query of punctuation alone matches nothing here.
  const words = wanted.split(/[^a-z0-9_.]+/).filter((w) => /[a-z0-9]/.test(w))
  const exact: OverlayResult[] = []
  const rest: OverlayResult[] = []
  for (const s of found.symbols) {
    if (opts.kind !== undefined && s.kind !== opts.kind) continue
    const inner = `${s.parent ? `${s.parent}.` : ''}${s.name}`
    if (words.length === 0 || !words.every((w) => `${inner} ${s.path}`.toLowerCase().includes(w))) continue
    const hit: OverlayResult = {
      id: `overlay:${s.path}:${s.startLine}:${inner}`,
      fileId: null,
      repositoryId,
      path: s.path,
      name: s.name,
      kind: s.kind,
      ...(s.parent ? { parent: s.parent } : {}),
      startLine: s.startLine,
      endLine: s.endLine,
      snippet: s.snippet,
      score: 0,
    }
    ;(s.name.toLowerCase() === wanted || inner.toLowerCase() === wanted ? exact : rest).push(hit)
  }
  return { hits: [...exact, ...rest, ...base.filter((r) => !found.changed.has(r.path))].slice(0, opts.limit), skipped: found.skipped, stale: found.stale }
}
