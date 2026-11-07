import { repositoryMap, vaultOutline, ORIENT_ENTRIES, type OrientFolder, type OrientNote, type OrientSymbol } from '../repositories/orient.js'
import { repositoryIndexedVersion } from '../repositories/store.js'
import { z } from 'zod'
import { folderOf, keyset, ranked, type Budgeted, type Page } from './response.js'

/** Characters of `query` and of each `focus` entry, and focus entries, `orient` reads. */
const MAX_QUERY = 200
const MAX_FOCUS = 5

/**
 * `orient` (#534): where to start in a repository and a vault, one level at a time. Each list is the first
 * `ORIENT_ENTRIES` of a ranking (repositories/orient.ts), `">10"` in `truncated.total` when more exist (#534); the level is
 * `path`, and `folders` / `outline` name the paths to pass to go one level down; `truncated.cursor` continues the definitions ten at a time. The sections fit the budget as
 * every list does (response.ts).
 */
export async function orientAnswer(
  resources: { vaultIds: string[]; repositoryIds: string[] },
  args: { query?: string; focus?: string[]; path?: string },
  page: Page,
): Promise<Budgeted> {
  const folder = args.path?.replace(/^\/+|\/+$/g, '') || null
  // Bounded: `focus` is unnested per candidate row in SQL.
  const opts = { query: args.query?.slice(0, MAX_QUERY), focus: args.focus?.slice(0, MAX_FOCUS).map((f) => f.slice(0, MAX_QUERY)), folder }
  // The cursor continues the definitions (the last list; the cursor is bound to the call's scope, response.ts `argsFingerprint`).
  // `folders` and `outline` are ten entries and a `">10"` total: a deeper level is a `path`. Were they paged, a list with
  // more would end the page before the definitions, the main answer, were shown (response.ts `fill`).
  const repos = resources.repositoryIds
  const symbolAt = (i: number) => repos.length + resources.vaultIds.length + i
  const resumed = page.at?.s ?? -1
  const offsetOf = (n: number) => (n === resumed ? page.after(n, z.number().int().min(0)) ?? 0 : 0)
  const maps = await Promise.all(repos.map((id, i) => repositoryMap(id, opts, { symbols: offsetOf(symbolAt(i)) })))
  // The indexed version once, when one repository is in scope (#471).
  const head = repos.length === 1 ? await repositoryIndexedVersion(repos[0]!) : {}
  const outlines = await Promise.all(resources.vaultIds.map((id) => vaultOutline(id, opts)))
  return {
    head,
    sections: [
      ...maps.map((m) => ranked<OrientFolder>({ name: 'folders', items: m.folders, id: (f) => f.path, limit: ORIENT_ENTRIES, ladder: { locations: (f) => f.path, group: (f) => folderOf(f.path) } })),
      ...outlines.map((rows) => ranked<OrientNote>({ name: 'outline', items: rows, id: (n) => n.path, limit: ORIENT_ENTRIES, ladder: { locations: (n) => n.path, group: (n) => folderOf(n.path) } })),
      ...maps.map((m, i) => {
        const offset = offsetOf(symbolAt(i))
        return keyset<OrientSymbol>({
          name: 'symbols',
          items: m.symbols.slice(0, ORIENT_ENTRIES),
          limit: ORIENT_ENTRIES,
          more: m.symbols.length > ORIENT_ENTRIES,
          resume: (_row, k) => offset + k + 1,
          // Down the ladder: without the signature, then `path:line` and the symbol, counted per file.
          ladder: { no_context: (sym) => ({ ...sym, sig: undefined }), locations: (sym) => `${sym.at} ${sym.symbol}`, group: (sym) => sym.at.slice(0, sym.at.lastIndexOf(':')) },
        })
      }),
    ],
  }
}
