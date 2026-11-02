import { repositoryMap, vaultOutline, ORIENT_ENTRIES, type OrientFolder, type OrientNote, type OrientSymbol } from '../repositories/orient.js'
import { repositoryIndexedVersion } from '../repositories/store.js'
import { folderOf, ranked, type Budgeted } from './response.js'

/**
 * `orient` (#534): where to start in a repository and a vault, one level at a time. Each list is the first
 * `ORIENT_ENTRIES` of a ranking (repositories/orient.ts), `">10"` in `truncated.total` when more exist; the level is
 * `path`, and `folders` / `outline` name the paths to pass to go one level down. The sections fit the budget as
 * every list does (response.ts).
 */
export async function orientAnswer(
  resources: { vaultIds: string[]; repositoryIds: string[] },
  args: { query?: string; focus?: string[]; path?: string },
): Promise<Budgeted> {
  const folder = args.path?.replace(/^\/+|\/+$/g, '') || null
  const opts = { query: args.query, focus: args.focus, folder }
  const sections: Budgeted['sections'] = []
  let head: Record<string, unknown> = {}
  for (const repositoryId of resources.repositoryIds) {
    const map = await repositoryMap(repositoryId, opts)
    // The indexed version once, when one repository is in scope (#471).
    if (resources.repositoryIds.length === 1) head = { ...head, ...(await repositoryIndexedVersion(repositoryId)) }
    sections.push(
      ranked<OrientSymbol>({
        name: 'symbols',
        items: map.symbols,
        id: (s) => `${s.at} ${s.symbol}`,
        limit: ORIENT_ENTRIES,
        // Down the ladder: without the signature, then `path:line` and the symbol, counted per file.
        ladder: { no_context: (s) => ({ ...s, sig: undefined }), locations: (s) => `${s.at} ${s.symbol}`, group: (s) => s.at.slice(0, s.at.lastIndexOf(':')) },
      }),
      ranked<OrientFolder>({ name: 'folders', items: map.folders, id: (f) => f.path, limit: ORIENT_ENTRIES, ladder: { locations: (f) => f.path, group: (f) => folderOf(f.path) } }),
    )
  }
  for (const vaultId of resources.vaultIds) {
    sections.push(
      ranked<OrientNote>({
        name: 'outline',
        items: await vaultOutline(vaultId, opts),
        id: (n) => n.path,
        limit: ORIENT_ENTRIES,
        ladder: { locations: (n) => n.path, group: (n) => folderOf(n.path) },
      }),
    )
  }
  return { head, sections }
}
