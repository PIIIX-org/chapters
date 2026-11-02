import { z } from 'zod'
import { CodeQueryError, askCode, checkRefsArguments, type RefsArgs, type Row } from '../repositories/code-refs.js'
import { McpToolError } from './errors.js'
import { keyset, ranked, type Budgeted, type Ladder, type Page } from './response.js'

/**
 * `find_symbols` with `refs` (#470) as a budgeted answer: the answer of
 * repositories/code-refs.ts in sections. Lists that page (`results`) are
 * keyset sections whose cursor holds the offset; `impact`'s levels
 * (`depth1`..`depth3`) and the `candidates` of an ambiguous name are ranked
 * sections bounded by `limit`.
 */
export { REFS, type Refs } from '../repositories/code-refs.js'

/** The refusal of a code question, as the tool's error. */
const toolError = (err: unknown): unknown =>
  err instanceof CodeQueryError ? new McpToolError(err.code, err.message, err.field ? { field: err.field } : {}) : err

/** Arguments `find_symbols` would ignore without `refs` (or with another one) are refused. */
export function refsArguments(args: Parameters<typeof checkRefsArguments>[0]): void {
  try {
    checkRefsArguments(args)
  } catch (err) {
    throw toolError(err)
  }
}

/** Rows down the ladder: without context, then `path:line`, counted per file. */
const ROWS: Ladder<Row> = {
  no_context: (r) => ({ ...r, context: undefined }),
  locations: (r) => r.at,
  group: (r) => r.at.slice(0, r.at.lastIndexOf(':')),
}
/** What a line refers to, down the ladder: by name, counted per kind. */
const LINE: Ladder<{ kind: string; name: string }> = { locations: (r) => r.name, group: (r) => r.kind }

/** The answer to a `refs` call in `repositoryId`, which the caller has checked the account may read. */
export async function refsAnswer(repositoryId: string, args: RefsArgs, page: Page): Promise<Budgeted> {
  // The cursor holds the offset the next page starts at.
  const offset = page.after(0, z.number().int().min(0)) ?? 0
  let answer
  try {
    answer = await askCode(repositoryId, { ...args, offset })
  } catch (err) {
    throw toolError(err)
  }
  const { limit } = answer
  return {
    head: answer.head,
    sections: answer.lists.map((list) =>
      list.paged
        ? keyset({
            name: list.name,
            items: list.rows.slice(0, limit),
            limit,
            more: list.rows.length > limit,
            resume: (_r, i) => offset + i + 1,
            ladder: (args.refs === 'at' ? LINE : ROWS) as Ladder<unknown>,
          })
        : ranked({
            name: list.name,
            items: list.rows,
            id: (r) => JSON.stringify(r),
            limit,
            ...(list.name === 'candidates' ? {} : { ladder: ROWS as Ladder<unknown> }),
          }),
    ),
  }
}
