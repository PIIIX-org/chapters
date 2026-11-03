import type { SearchResult } from '../search/search.js'

/** A hit as the MCP `search` answer carries it: `containerId` and a note's or file's `id` are left out when they say nothing the call or the path does not. */
export type LeanHit = Omit<SearchResult, 'containerId' | 'id'> & { containerId?: string; id?: string }

/**
 * A search hit as the MCP `search` answer carries it (#414). The answer has a token budget, so every field a hit
 * repeats is a hit that falls off the end of the list:
 * - `containerId` when the call named its one vault or repository (or the token is pinned to it); not with `everywhere`, whatever it reached;
 * - `id` of a note or a file: no tool takes it (reads and the graph take the path), a symbol's stays for `find_symbols`;
 * - `type` on a code hit, which is its `language` again;
 * - the digits of `score` after the fifth decimal (the list is already in score order; REST keeps the full value).
 */
export function leanHit(hit: SearchResult, singleContainer: boolean): LeanHit {
  const { containerId, id, type, ...rest } = hit
  return {
    ...rest,
    ...(hit.resourceType === 'symbol' ? { id } : {}),
    ...(singleContainer ? {} : { containerId }),
    ...(hit.resourceType === 'code' && type === hit.language ? {} : { type }),
    score: Math.round(hit.score * 1e5) / 1e5,
  }
}

/** What identifies a lean hit in a list (a cursor's guard): a symbol's id, else its container and path. */
export const leanHitKey = (hit: LeanHit): string => (hit.resourceType === 'symbol' ? `symbol:${hit.id}` : `${hit.resourceType}:${hit.containerId ?? ''}:${hit.path}`)
