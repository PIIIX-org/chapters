import { isDeepStrictEqual } from 'node:util'

/**
 * Frontmatter key order (ADR-003 §4, Q3). `notes.frontmatter` is jsonb, which
 * returns keys in its own order (by length, then bytes), while `serializeNote`
 * writes keys in object order. `notes.frontmatter_src` (json) keeps the order
 * the note's file has, so a file the server wrote keeps its bytes.
 *
 * `orderKeys(src, next)` is `next` in `src`'s order:
 * - a key already in `src` keeps its place;
 * - a key whose value is deep-equal to `src`'s keeps `src`'s value, so a
 *   nested map keeps its key order too;
 * - a new key is appended in `next`'s order (the writer's order).
 */
export function orderKeys(src: Record<string, unknown> | null | undefined, next: Record<string, unknown>): Record<string, unknown> {
  if (!src) return { ...next }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(src)) {
    if (!Object.hasOwn(next, key)) continue
    out[key] = isDeepStrictEqual(normal(src[key]), normal(next[key])) ? src[key] : next[key]
  }
  for (const key of Object.keys(next)) if (!Object.hasOwn(out, key)) out[key] = next[key]
  return out
}

/**
 * The frontmatter a note is rendered and read with: `frontmatter_src` when it
 * holds the same content as the row's jsonb (it was written by the store),
 * otherwise the row's (a row changed by old code or SQL; the next store write
 * resets `frontmatter_src`).
 */
export function presentedFrontmatter(frontmatter: unknown, src: unknown): Record<string, unknown> {
  const row = (frontmatter ?? {}) as Record<string, unknown>
  if (src && typeof src === 'object' && !Array.isArray(src) && sameContent(src as Record<string, unknown>, row)) {
    return src as Record<string, unknown>
  }
  return row
}

/** Deep equality of two frontmatter maps as jsonb compares them: key order never counts. */
export function sameContent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return isDeepStrictEqual(normal(a), normal(b))
}

/** A JSON value with object keys sorted (and `undefined` members dropped), for order-free comparison. */
function normal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normal)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = normal(v)
    }
    return out
  }
  return value
}
