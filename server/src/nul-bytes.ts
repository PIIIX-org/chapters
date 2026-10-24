/**
 * NUL bytes (U+0000) in request strings (#443). Postgres `text` and `jsonb`
 * cannot hold one (SQLSTATE 22021, 22P05), so a NUL that reached a query
 * failed it; the MCP tools/call wrapper and the REST `preValidation` hook
 * refuse one first, naming the field. Only NUL is refused: tab, LF, CR and
 * the other control characters are stored as sent, as notes and repository
 * files already hold them (plan note fixes/443-nul-clean-error).
 */

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Body paths app.ts's NUL hook does not look into (`findNulByte`'s
     * `allowed`; '' is the whole body): only a route that handles a NUL
     * there itself names them. Path parameters and the query string are
     * always checked.
     */
    nulBytesAllowed?: readonly string[]
  }
}

export interface NulByte {
  /**
   * Dotted path from the walked value (`frontmatter.title`, `ops.0.text`),
   * '' for the value itself. For a key holding the NUL it is the key's own
   * path, the NUL shown as `\0` (`frontmatter.k\0`).
   */
  field: string
  /** The NUL is in an object key, not in a string value. */
  inKey: boolean
}

/** A key is shown in a field path up to this many characters. */
const MAX_KEY_CHARS = 64

const isWalked = (value: object): boolean => {
  if (Array.isArray(value)) return true
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Whether `field` matches one of `allowed`: dotted paths where a `*` segment is any key or index, '' the value itself. */
const isAllowed = (field: string, allowed: readonly string[]): boolean =>
  allowed.some((pattern) => {
    if (pattern === '' || field === '') return pattern === field
    const want = pattern.split('.')
    const got = field.split('.')
    return want.length === got.length && want.every((segment, i) => segment === '*' || segment === got[i])
  })

const shownKey = (key: string): string => {
  const shown = key.replaceAll('\0', '\\0')
  return shown.length > MAX_KEY_CHARS ? `${shown.slice(0, MAX_KEY_CHARS)}…` : shown
}

/**
 * The first string or object key holding a NUL in `value`, if any. Values
 * at an `allowed` path (see `isAllowed`) are not looked into: a route that
 * takes raw file content and cleans it itself names it. Only plain objects
 * and arrays are walked (parsed JSON, a query string), not a Buffer or a
 * stream; iteratively, so a deeply nested body cannot overflow the stack.
 */
export function findNulByte(value: unknown, allowed: readonly string[] = []): NulByte | undefined {
  const stack: Array<[unknown, string]> = [[value, '']]
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [current, field] = next
    if (allowed.length > 0 && isAllowed(field, allowed)) continue
    if (typeof current === 'string') {
      if (current.includes('\0')) return { field, inKey: false }
      continue
    }
    if (current === null || typeof current !== 'object' || !isWalked(current)) continue
    const entries = Object.entries(current)
    const key = entries.find(([k]) => k.includes('\0'))?.[0]
    if (key !== undefined) return { field: field ? `${field}.${shownKey(key)}` : shownKey(key), inKey: true }
    for (let i = entries.length - 1; i >= 0; i--) {
      const [k, child] = entries[i]!
      stack.push([child, field ? `${field}.${k}` : k])
    }
  }
  return undefined
}

/** The refusal's text for a NUL at `field`. */
export function nulByteMessage(field: string, inKey: boolean): string {
  return `${field}: NUL bytes (U+0000) are not allowed${inKey ? ' (in a key)' : ''}`
}
