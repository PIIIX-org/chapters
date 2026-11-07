import { repositoryMap, vaultOutline, ORIENT_ENTRIES, type OrientFolder, type OrientNote, type OrientSymbol } from '../repositories/orient.js'
import { repositoryIndexedVersion } from '../repositories/store.js'
import { z } from 'zod'
import { folderOf, keyset, type Budgeted, type Ladder, type Page, type Section } from './response.js'

/** Characters of `query` and of each `focus` entry, and focus entries, `orient` reads. */
const MAX_QUERY = 200
const MAX_FOCUS = 5

/**
 * `orient` (#534): where to start in a repository and a vault, one level at a time. Each list is the first
 * `ORIENT_ENTRIES` of a ranking (repositories/orient.ts), `">10"` in `truncated.total` when more exist (#534); the level is
 * `path`, and `folders` / `outline` name the paths to pass to go one level down; the cursor of a list with more goes on to its next ten. The sections fit the budget as
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
  let head: Record<string, unknown> = {}
  // The cursor continues one list (its section index and the offset it resumes at; response.ts): the lists before it are
  // done, the lists after it come from their start once it is finished. A list with more entries ends its page, so the
  // short lists (folders, outline) come first and the definitions last.
  const resumed = page.at?.s ?? -1
  const offsetOf = (n: number) => (n === resumed ? page.after(n, z.number().int().min(0)) ?? 0 : 0)
  const repos = resources.repositoryIds
  const folderAt = (i: number) => i
  const outlineAt = (j: number) => repos.length + j
  const symbolAt = (i: number) => repos.length + resources.vaultIds.length + i
  /** One list as a keyset section: `rows` is its page + 1 fetched from `offsetOf(n)`; the cursor holds the offset after the last shown entry. */
  const list = <T>(name: string, n: number, rows: T[], ladder: Ladder<T>): Section => {
    const offset = offsetOf(n)
    return keyset<T>({ name, items: rows.slice(0, ORIENT_ENTRIES), limit: ORIENT_ENTRIES, more: rows.length > ORIENT_ENTRIES, resume: (_row, i) => offset + i + 1, ladder })
  }
  const maps = await Promise.all(repos.map((id, i) => repositoryMap(id, opts, { symbols: offsetOf(symbolAt(i)), folders: offsetOf(folderAt(i)) })))
  // The indexed version once, when one repository is in scope (#471).
  if (repos.length === 1) head = await repositoryIndexedVersion(repos[0]!)
  const outlines = await Promise.all(resources.vaultIds.map((id, j) => vaultOutline(id, opts, offsetOf(outlineAt(j)))))
  return {
    head,
    sections: [
      ...maps.map((m, i) => list<OrientFolder>('folders', folderAt(i), m.folders, { locations: (f) => f.path, group: (f) => folderOf(f.path) })),
      ...outlines.map((rows, j) => list<OrientNote>('outline', outlineAt(j), rows, { locations: (note) => note.path, group: (note) => folderOf(note.path) })),
      // Down the ladder: without the signature, then `path:line` and the symbol, counted per file.
      ...maps.map((m, i) =>
        list<OrientSymbol>('symbols', symbolAt(i), m.symbols, {
          no_context: (sym) => ({ ...sym, sig: undefined }),
          locations: (sym) => `${sym.at} ${sym.symbol}`,
          group: (sym) => sym.at.slice(0, sym.at.lastIndexOf(':')),
        }),
      ),
    ],
  }
}
