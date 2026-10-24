import { z } from 'zod'

/**
 * Names agents commonly send for a parameter they meant (#437), keyed by the
 * lower-cased name without `_` or `-`. The first candidate the schema
 * actually has is suggested.
 */
const COMMON_GUESSES: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({
    content: ['body'],
    contents: ['body'],
    text: ['body', 'query'],
    markdown: ['body'],
    md: ['body'],
    q: ['query'],
    search: ['query'],
    term: ['query'],
    keyword: ['query'],
    keywords: ['query'],
    title: ['name'],
    vault: ['vaultId'],
    repo: ['repositoryId'],
    repository: ['repositoryId'],
    repoid: ['repositoryId'],
    note: ['path'],
    notepath: ['path'],
    file: ['path'],
    filepath: ['path'],
    filename: ['path'],
    newname: ['toName'],
    newpath: ['toName'],
    to: ['toName', 'target'],
    from: ['source'],
    max: ['limit'],
    maxresults: ['limit'],
    k: ['limit'],
    topk: ['limit'],
    count: ['limit'],
  }),
)

/** Unknown keys named in a refusal; the rest are counted (#769). */
const MAX_LISTED_KEYS = 10
/** Longer unknown key names are cut in a refusal (#769). */
const MAX_KEY_CHARS = 64

const normalize = (key: string): string => key.toLowerCase().replace(/[-_]/g, '')

/** Edits (insert, delete, substitute, swap two adjacent letters) that turn `a` into `b`. */
export function editDistance(a: string, b: string): number {
  let before: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j]!, before[j - 2]! + 1)
    }
    before = prev
    prev = row
  }
  return prev[b.length]!
}

/** The declared name an unknown key most likely meant, if any is close (also the error envelope's suggestion, #439). */
export function suggestion(key: string, names: readonly string[]): string | undefined {
  // No parameter or guess comes near this length, so a huge key skips
  // normalising and comparing (#769).
  if (key.length > MAX_KEY_CHARS) return undefined
  const wanted = normalize(key)
  const same = names.find((n) => normalize(n) === wanted)
  if (same) return same
  // A Map, so a key such as `constructor` is not looked up on Object.prototype (#769).
  const guessed = COMMON_GUESSES.get(wanted)?.find((g) => names.includes(g))
  if (guessed) return guessed
  const limit = wanted.length <= 4 ? 1 : 2
  let best: { name: string; distance: number } | undefined
  for (const name of names) {
    const distance = editDistance(wanted, normalize(name))
    if (distance <= limit && (!best || distance < best.distance)) best = { name, distance }
  }
  return best?.name
}

/** The refusal for undeclared keys: each key (with a suggestion when one is close) and the declared names. */
function unknownArgumentsMessage(label: string, keys: readonly string[], names: readonly string[]): string {
  const listed = keys.slice(0, MAX_LISTED_KEYS).map((key) => {
    const meant = suggestion(key, names)
    const shown = key.length > MAX_KEY_CHARS ? `${key.slice(0, MAX_KEY_CHARS)}…` : key
    return meant ? `"${shown}" (did you mean "${meant}"?)` : `"${shown}"`
  })
  if (keys.length > MAX_LISTED_KEYS) listed.push(`and ${keys.length - MAX_LISTED_KEYS} more`)
  const declared = names.length > 0 ? `${label} takes: ${names.join(', ')}` : `${label} takes no arguments`
  // No closing period: for a nested object the SDK appends ` at <field>`.
  return `unknown argument${keys.length === 1 ? '' : 's'} ${listed.join(', ')}; ${declared}`
}

/**
 * An object schema that rejects keys `shape` does not declare (#437), so a
 * misspelled or invented argument is an error instead of being dropped, and
 * its JSON Schema says `additionalProperties: false`. `label` names the
 * object in the refusal: the tool, or `<tool> <field>` for a nested object.
 * Free-form maps stay `z.record` fields and accept any key.
 */
export function strictArgs<S extends z.ZodRawShape>(label: string, shape: S): z.ZodObject<S, z.core.$strict> {
  const names = Object.keys(shape)
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys' ? unknownArgumentsMessage(label, issue.keys, names) : undefined,
  })
}
