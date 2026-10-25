/**
 * Identifiers for the keyword channel (#455). Postgres' text parser keeps
 * `parseFrontmatter` as one word (stemmed `parsefrontmatt`), a member access
 * `fm.parseFrontmatter` or a file name `mcp.server.ts` as one host lexeme
 * and a path as one file lexeme, so neither the parts of a name nor a name
 * inside a longer one could be found by keyword. Here a compound (words
 * joined by `.`, `-` or `::`; a word is letters, digits, `_` and `$`) is
 * split into its lowercased whole, its segments, its `_`/`$`-separated
 * words and their parts (camelCase and PascalCase humps, acronyms, digit
 * runs): `fm.parseFrontmatter` gives `fm.parsefrontmatter`, `fm`,
 * `parsefrontmatter`, `parse`, `frontmatter`.
 *
 * Index side (extraction, repositories/extraction-queue.ts): the lexemes of
 * a file and of a symbol, stored unstemmed (the `simple` way:
 * `array_to_tsvector`) beside the stemmed English `fts`. Query side
 * (search.ts `keywordQuery`): each term matches as the English query did,
 * or as its whole identifier, or as all its parts. Pure; a change to what is
 * stored needs an `EXTRACTOR_VERSION` bump (extraction.ts) so every file is
 * extracted again.
 */

const COMPOUND = /[\p{L}\p{N}_$]+(?:(?:\.|-|::)[\p{L}\p{N}_$]+)*/gu
const SEGMENT = /\.|-|::/
const WORD = /[_$]+/
const HAS_ALNUM = /[\p{L}\p{N}]/u

/** Lexemes per file, at most: a tsvector holds at most 1 MB, and a minified or generated file has many compounds. */
export const MAX_FILE_KEYWORDS = 20_000
/** A longer lexeme (a long member chain, an encoded blob) is not stored; its segments and parts still are. */
export const MAX_KEYWORD_LENGTH = 200

/** The parts of one word: `parseHTMLBody2` → `parse`, `HTML`, `Body`, `2`. */
function humps(word: string): string[] {
  return word
    .replace(/(\p{Ll})(?=\p{Lu})/gu, '$1 ')
    .replace(/(\p{Lu})(?=\p{Lu}\p{Ll})/gu, '$1 ')
    .replace(/(\p{L})(?=\p{N})/gu, '$1 ')
    .replace(/(\p{N})(?=\p{L})/gu, '$1 ')
    .split(' ')
}

export interface Identifier {
  /** The lowercased compound. */
  whole: string
  /** Its smallest parts, lowercased, in order. */
  parts: string[]
  /** Every lexeme it is stored as: whole, segments, words, parts. */
  lexemes: string[]
}

/** One compound split; `parts` is `[whole]` for a plain word (`parse`, `UUID`). */
export function splitIdentifier(compound: string): Identifier {
  const whole = compound.toLowerCase()
  const lexemes = new Set([whole])
  const parts: string[] = []
  for (const segment of compound.split(SEGMENT)) {
    lexemes.add(segment.toLowerCase())
    for (const word of segment.split(WORD)) {
      lexemes.add(word.toLowerCase())
      for (const part of humps(word)) {
        if (part === '') continue
        lexemes.add(part.toLowerCase())
        parts.push(part.toLowerCase())
      }
    }
  }
  return { whole, parts, lexemes: [...lexemes].filter((l) => HAS_ALNUM.test(l) && l.length <= MAX_KEYWORD_LENGTH) }
}

/** A plain word: one part, the word itself (no separator, no hump). */
export const isPlainWord = (id: Identifier): boolean => id.parts.length === 1 && id.parts[0] === id.whole

/** The compounds of `text`, split. */
function* identifiers(text: string): Generator<Identifier> {
  for (const [compound] of text.matchAll(COMPOUND)) yield splitIdentifier(compound)
}

/** Adds `lexemes` to `into` up to `MAX_FILE_KEYWORDS`; false once full. */
function addAll(into: Set<string>, lexemes: readonly string[]): boolean {
  for (const l of lexemes) {
    if (into.size >= MAX_FILE_KEYWORDS) return false
    into.add(l)
  }
  return true
}

/** Every lexeme of every compound of each path segment (`server/src/mcp.server.ts`: `server`, `src`, `mcp.server.ts`, `mcp`, `ts`). */
function pathLexemes(path: string, into: Set<string>): void {
  for (const id of identifiers(path.replaceAll('/', ' '))) addAll(into, id.lexemes)
}

/**
 * A repository file's keyword lexemes: its path's, and those of each
 * compound of `content` that is not a plain word (a plain word is already in
 * `fts`, stemmed). `content` null: a minified file, path only.
 */
export function fileKeywords(path: string, content: string | null): string[] {
  const out = new Set<string>()
  pathLexemes(path, out)
  if (content !== null) {
    for (const id of identifiers(content)) {
      if (!isPlainWord(id) && !addAll(out, id.lexemes)) break
    }
  }
  return [...out]
}

/**
 * A symbol's keyword lexemes: every lexeme of its `inner_path` (`Class.method`). Not its file's path, which
 * the code file leg matches: `server` must not find every symbol of every file under `server/`.
 */
export function symbolKeywords(innerPath: string): string[] {
  const out = new Set<string>()
  for (const id of identifiers(innerPath)) addAll(out, id.lexemes)
  return [...out]
}

/** A whitespace-separated query term: `text` as typed, and the identifiers in it. */
export interface KeywordTerm {
  text: string
  identifiers: Identifier[]
}

/**
 * `query`'s terms, or null when it uses `websearch_to_tsquery` syntax (a
 * quote, a `-term`, a standalone `or`), whose meaning the per-term query
 * would change: such a query keeps today's English one.
 */
export function keywordTerms(query: string): KeywordTerm[] | null {
  const tokens = query.split(/\s+/).filter((t) => t !== '')
  if (query.includes('"') || tokens.some((t) => t.startsWith('-') || t.toLowerCase() === 'or')) return null
  return tokens.map((text) => ({ text, identifiers: [...identifiers(text)] }))
}
