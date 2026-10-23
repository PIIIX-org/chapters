/**
 * NUL bytes (U+0000) in request strings (#443). Postgres `text` and `jsonb`
 * cannot hold one (SQLSTATE 22021, 22P05), so a NUL that reached a query
 * failed it; the MCP tools/call wrapper and the REST `preValidation` hook
 * refuse one first, naming the field. Only NUL is refused: tab, LF, CR and
 * the other control characters are stored as sent, as notes and repository
 * files already hold them (plan note fixes/443-nul-clean-error).
 */
export interface NulByte {
  /** Dotted path from the walked value (`frontmatter.title`, `ops.0.text`); '' for the value itself. */
  field: string
  /** The NUL is in a key of the object at `field`, not in a string value. */
  inKey: boolean
}

const isWalked = (value: object): boolean => {
  if (Array.isArray(value)) return true
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * The first string or object key holding a NUL in `value`, if any. Only
 * plain objects and arrays are walked (parsed JSON, a query string), not a
 * Buffer or a stream; iteratively, so a deeply nested body cannot overflow
 * the stack.
 */
export function findNulByte(value: unknown): NulByte | undefined {
  const stack: Array<[unknown, string]> = [[value, '']]
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [current, field] = next
    if (typeof current === 'string') {
      if (current.includes('\0')) return { field, inKey: false }
      continue
    }
    if (current === null || typeof current !== 'object' || !isWalked(current)) continue
    const entries = Object.entries(current)
    if (entries.some(([key]) => key.includes('\0'))) return { field, inKey: true }
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, child] = entries[i]!
      stack.push([child, field ? `${field}.${key}` : key])
    }
  }
  return undefined
}

/** The refusal's text for a NUL at `field`. */
export function nulByteMessage(field: string, inKey: boolean): string {
  return `${field}: NUL bytes (U+0000) are not allowed${inKey ? ' (in a key)' : ''}`
}
