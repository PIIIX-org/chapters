import type { SearchResult } from '../search/search.js'

/** A hit as the MCP `search` answer carries it: `containerId` is left out when the call named its container, and a note's `frontmatter` always (#419). */
export type LeanHit = Omit<SearchResult, 'containerId' | 'frontmatter' | 'block' | 'channel'> & { containerId?: string; frontmatter?: undefined; block?: undefined; channel?: undefined }

/**
 * A search hit as the MCP `search` answer carries it (#414). The answer has a token budget, so every field a hit
 * repeats is a hit that falls off the end of the list:
 * - `frontmatter` of a note hit (#419: `read_note` has it, REST keeps it for the client's tags);
 * - `block` and `channel` (#1122: agents read by `startLine`-`endLine` (1 read target in 368 named a block in the trial's traces), and no tool takes a channel; REST keeps both);
 * - `containerId` when the call named its one vault or repository (or the token is pinned to it); not with `everywhere`, whatever it reached;
 * - `type` when it is the `language` of a code hit or the `symbolKind` of a symbol hit;
 * - `heading` of a symbol hit: its `symbolName` (and `symbolParent`) is the name path;
 * - the digits of `score` after the fifth decimal (the list is already in score order; REST keeps the full value).
 * A hit keeps its `id`: the usage report (#678) reads hits by it.
 */
export function leanHit(hit: SearchResult, singleContainer: boolean): LeanHit {
  const { containerId, type, heading, ...rest } = hit
  const typeRepeats = (hit.resourceType === 'code' && type === hit.language) || (hit.resourceType === 'symbol' && type === hit.symbolKind)
  return {
    ...rest,
    frontmatter: undefined,
    block: undefined,
    channel: undefined,
    ...(singleContainer ? {} : { containerId }),
    ...(typeRepeats ? {} : { type }),
    ...(heading === undefined || hit.resourceType === 'symbol' ? {} : { heading }),
    score: Math.round(hit.score * 1e5) / 1e5,
  }
}
