import { z } from 'zod'
import { ChangedSinceError, changedSince } from '../repositories/changes.js'
import { McpToolError } from './errors.js'
import { folderOf, keyset, type Budgeted, type Page } from './response.js'
import { type IndexedVersion } from '../repositories/store.js'

/** Files per page of `browse_repository`'s `changed_since` answer, as the files listing's. */
const CHANGES_PAGE = 500

/**
 * `browse_repository` with `changed_since` (#471): the files changed since a commit or a date, from the index's
 * own version history (repositories/changes.ts), as a keyset section in path order. `since` names the version they
 * are measured from (its commit and when it was indexed), so a date's resolution is visible.
 */
export async function changedFilesAnswer(
  repositoryId: string,
  since: string,
  folder: string | null,
  version: IndexedVersion,
  page: Page,
): Promise<Budgeted> {
  let answer
  try {
    answer = await changedSince(repositoryId, since, { folder, after: page.after(0, z.string()), limit: CHANGES_PAGE + 1 })
  } catch (err) {
    if (err instanceof ChangedSinceError) throw new McpToolError('INVALID_ARGUMENT', err.message, { field: 'changed_since' })
    throw err
  }
  const files = answer.files.slice(0, CHANGES_PAGE).map(({ path, kind, language, size }) => ({ path, kind, ...(kind === 'deleted' ? {} : { language, size }) }))
  return {
    // `since: null`: the date predates the history, which starts at `historyStartsAt` (its first version's files are not changes).
    head: {
      ...version,
      since: answer.base ? { ...(answer.base.commit ? { commit: answer.base.commit } : {}), at: answer.base.at } : null,
      ...(answer.historyStartsAt ? { historyStartsAt: answer.historyStartsAt } : {}),
    },
    sections: [
      keyset({
        name: 'files',
        items: files,
        limit: CHANGES_PAGE,
        more: answer.files.length > CHANGES_PAGE,
        resume: (f) => f.path,
        ladder: { no_context: ({ path, kind }) => ({ path, kind }), locations: (f) => f.path, group: (f) => folderOf(f.path) },
      }),
    ],
  }
}
