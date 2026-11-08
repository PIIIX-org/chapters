import { z } from 'zod'
import { GrepError, MAX_CONTEXT, encodePosition, grep, parsePosition, grepTargets, type GrepHit, type GrepPosition } from '../repositories/grep.js'
import { repositoryIndexedVersion } from '../repositories/store.js'
import { McpToolError } from './errors.js'
import { intRange, keyset, location, type Budgeted, type Page } from './response.js'

/**
 * `grep` (#468): a regular expression over notes and code as located hits
 * (repositories/grep.ts has the rules). A hit is `{path, line, block, tokens,
 * snippet}` with `lines` when `context` widens the snippet; hits are in path
 * then line order and page with the cursor. A scan that stopped at its cap ends
 * the list with `{capped: {files, after}}` and `truncated` carries the cursor
 * that continues it.
 */
export const GREP_INPUT = {
  // The length bounds are checked in repositories/grep.ts, not listed: `minLength`/`maxLength` cost reader tokens (as `intRange`).
  pattern: z.string().describe('Regex; (?i) ignores case'),
  path: z.string().optional().describe('Glob, e.g. src/**/*.ts'),
  context: intRange('context', 0, MAX_CONTEXT).optional().describe('Context lines'),
}

/**
 * Hits an MCP page fetches (#1122; REST keeps `PAGE_HITS`, 50). The trial's recorded grep calls replayed at this cap:
 * 4,715 -> 3,654 characters per call (-22 %), the page holding a fact's evidence line in 217 of the 232 calls it
 * held it at 50 (the cursor continues past it). shortcut: a count, not a character budget per hit; a per-hit width cap
 * (`LINE_CHARS` 500) if the replay shows lines, not hits, dominating.
 */
export const MCP_PAGE_HITS = 20

interface Capped {
  capped: { files: number; after: string }
}

const Position = z.string().regex(/^\d+:\d+:/)

export async function grepAnswer(
  resources: { vaultIds: string[]; repositoryIds: string[] },
  args: { pattern: string; path?: string; context?: number },
  page: Page,
): Promise<Budgeted> {
  const targets = await grepTargets(resources.vaultIds, resources.repositoryIds)
  const at = page.after(0, Position)
  const after: GrepPosition | null = at === null ? null : parsePosition(at)
  const limit = MCP_PAGE_HITS
  let answer
  try {
    answer = await grep(targets, { pattern: args.pattern, glob: args.path?.replace(/^(?:\.?\/)+/, ''), context: args.context ?? 0, limit, after })
  } catch (err) {
    throw err instanceof GrepError ? new McpToolError(err.code, err.message, err.field ? { field: err.field } : {}) : err
  }
  const items: Array<GrepHit | Capped> = [...answer.hits]
  if (answer.capped) items.push({ capped: { files: answer.scanned.files, after: answer.capped.path } })
  const repositoryId = resources.repositoryIds.length === 1 && resources.vaultIds.length === 0 ? resources.repositoryIds[0]! : null
  return {
    head: { scanned: answer.scanned.files, ...(repositoryId ? await repositoryIndexedVersion(repositoryId) : {}) },
    sections: [
      keyset<GrepHit | Capped>({
        name: 'hits',
        items,
        limit,
        more: answer.more || answer.capped !== null,
        resume: (_item, i) => encodePosition(i < answer.hits.length ? answer.positions[i]! : answer.capped!),
        // Down the ladder: without the snippet, then `path#La-Lb`; counted per file.
        ladder: {
          no_context: (h) => ('capped' in h ? h : { ...h, snippet: undefined }),
          locations: (h) => ('capped' in h ? h : location(h.path, h.lines?.[0] ?? h.line, h.lines?.[1] ?? h.line)),
          group: (h) => ('capped' in h ? '(not scanned)' : h.path),
        },
      }),
    ],
    narrow: args.path === undefined ? ['path: "src/**"'] : [],
  }
}
