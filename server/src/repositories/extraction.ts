import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Parser, Language, Query, Tree } from 'web-tree-sitter'

const require = createRequire(import.meta.url)

/**
 * Version of everything that turns a repository file's content into its
 * imports and symbols (#453): the grammars and queries below, the symbol
 * kinds, and in extraction-queue.ts the minified-file rule, the snippet cut
 * and the symbol embed text. Bump it with any change to those: it is part of
 * the `extract` job key and stored on `repository_files.extractor_version`,
 * so the next boot re-extracts every file another version produced (old rows
 * stay searchable until each file's new result commits).
 * 1: tree-sitter TypeScript, JavaScript, Python, Go, imports with their line
 * (#558). Rows extracted before #453 carry 0.
 * 2: `.tsx` parsed with the TSX grammar (#449); `.mts`/`.cts` extracted as
 * TypeScript, and `.mts/.cts/.mjs/.cjs` import candidates (#451).
 */
export const EXTRACTOR_VERSION = 2

export type SymbolKind = 'function' | 'class' | 'interface' | 'type'

export interface ExtractedSymbol {
  name: string
  kind: SymbolKind
  startLine: number
  endLine: number
}

/** An import specifier and the line it is written on (1-based). */
export interface ExtractedImport {
  target: string
  line: number
}

export interface ExtractionResult {
  imports: ExtractedImport[]
  symbols: ExtractedSymbol[]
}

type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'go'

const SUPPORTED = new Set<SupportedLanguage>(['typescript', 'javascript', 'python', 'go'])

export function isSupportedLanguage(language: string | null): language is SupportedLanguage {
  return language !== null && SUPPORTED.has(language as SupportedLanguage)
}

const wasmPath = (pkg: string, file: string): string =>
  join(dirname(require.resolve(`${pkg}/package.json`)), file)

interface GrammarConfig {
  wasm: string
  importQuery: string
  symbolQuery: string
}

/** A grammar: the language's own, or TSX for a `.tsx` file (#449). */
type Grammar = SupportedLanguage | 'tsx'

const TYPESCRIPT_IMPORT_QUERY = `(import_statement source: (string (string_fragment) @src))`
const TYPESCRIPT_SYMBOL_QUERY = `
      [
        (function_declaration name: (identifier) @name) @decl.function
        (class_declaration name: (type_identifier) @name) @decl.class
        (interface_declaration name: (type_identifier) @name) @decl.interface
        (type_alias_declaration name: (type_identifier) @name) @decl.type
      ]
    `

const GRAMMARS: Record<Grammar, GrammarConfig> = {
  typescript: {
    wasm: wasmPath('tree-sitter-typescript', 'tree-sitter-typescript.wasm'),
    importQuery: TYPESCRIPT_IMPORT_QUERY,
    symbolQuery: TYPESCRIPT_SYMBOL_QUERY,
  },
  // TypeScript plus JSX, from the same package; the node types match, so do the queries.
  tsx: {
    wasm: wasmPath('tree-sitter-typescript', 'tree-sitter-tsx.wasm'),
    importQuery: TYPESCRIPT_IMPORT_QUERY,
    symbolQuery: TYPESCRIPT_SYMBOL_QUERY,
  },
  javascript: {
    wasm: wasmPath('tree-sitter-javascript', 'tree-sitter-javascript.wasm'),
    importQuery: `(import_statement source: (string (string_fragment) @src))`,
    symbolQuery: `
      [
        (function_declaration name: (identifier) @name) @decl.function
        (class_declaration name: (identifier) @name) @decl.class
      ]
    `,
  },
  python: {
    wasm: wasmPath('tree-sitter-python', 'tree-sitter-python.wasm'),
    importQuery: `
      [
        (import_statement name: (dotted_name) @src)
        (import_from_statement module_name: (dotted_name) @src)
        (import_from_statement module_name: (relative_import) @src)
      ]
    `,
    symbolQuery: `
      [
        (function_definition name: (identifier) @name) @decl.function
        (class_definition name: (identifier) @name) @decl.class
      ]
    `,
  },
  go: {
    wasm: wasmPath('tree-sitter-go', 'tree-sitter-go.wasm'),
    importQuery: `(import_spec path: (interpreted_string_literal (interpreted_string_literal_content) @src))`,
    symbolQuery: `
      [
        (function_declaration name: (identifier) @name) @decl.function
        (type_declaration (type_spec name: (type_identifier) @name)) @decl.type
      ]
    `,
  },
}

const SYMBOL_KIND_BY_CAPTURE: Record<string, SymbolKind> = {
  'decl.function': 'function',
  'decl.class': 'class',
  'decl.interface': 'interface',
  'decl.type': 'type',
}

let initPromise: Promise<void> | null = null
const languageCache = new Map<Grammar, Language>()
const queryCache = new Map<string, Query>()

function getCompiledQuery(lang: Language, grammar: Grammar, type: 'import' | 'symbol', queryString: string): Query {
  const key = `${grammar}:${type}`
  let query = queryCache.get(key)
  if (!query) {
    query = new Query(lang, queryString)
    queryCache.set(key, query)
  }
  return query
}

/** Loads a grammar's `.wasm` the first time a file needs it. */
async function loadLanguage(grammar: Grammar): Promise<Language> {
  initPromise ??= Parser.init()
  await initPromise
  let lang = languageCache.get(grammar)
  if (!lang) {
    const wasmBytes = await readFile(GRAMMARS[grammar].wasm)
    lang = await Language.load(wasmBytes)
    languageCache.set(grammar, lang)
  }
  return lang
}

/**
 * Tree-sitter, file-level extraction (spec 9): import edges + cheap top-level
 * "contains" symbols. `path` picks the grammar where a language has several.
 */
export async function extractStructure(language: string, content: string, path: string): Promise<ExtractionResult> {
  if (!isSupportedLanguage(language)) {
    throw new Error(`unsupported language for extraction: ${language}`)
  }
  // The grammar comes from the extension, not the label: a `.tsx` file is
  // labelled `typescript` (language.ts) but JSX only parses with TSX, and TSX
  // cannot parse the `<T>value` casts `.ts/.mts/.cts` allow.
  const grammar: Grammar = language === 'typescript' && /\.tsx$/i.test(path) ? 'tsx' : language
  const config = GRAMMARS[grammar]
  const lang = await loadLanguage(grammar)
  const parser = new Parser()
  parser.setLanguage(lang)

  let tree: Tree | null = null
  try {
    tree = parser.parse(content)
    if (!tree) return { imports: [], symbols: [] }

    const importQuery = getCompiledQuery(lang, grammar, 'import', config.importQuery)
    const imports: ExtractedImport[] = []
    for (const match of importQuery.matches(tree.rootNode)) {
      for (const capture of match.captures) imports.push({ target: capture.node.text, line: capture.node.startPosition.row + 1 })
    }

    const symbolQuery = getCompiledQuery(lang, grammar, 'symbol', config.symbolQuery)
    const symbols: ExtractedSymbol[] = []
    for (const match of symbolQuery.matches(tree.rootNode)) {
      const nameCapture = match.captures.find((c) => c.name === 'name')
      const declCapture = match.captures.find((c) => c.name in SYMBOL_KIND_BY_CAPTURE)
      if (!nameCapture || !declCapture) continue
      symbols.push({
        name: nameCapture.node.text,
        kind: SYMBOL_KIND_BY_CAPTURE[declCapture.name]!,
        startLine: declCapture.node.startPosition.row + 1,
        endLine: declCapture.node.endPosition.row + 1,
      })
    }

    return { imports, symbols }
  } finally {
    // ponytail: explicitly delete Tree and Parser to release WebAssembly linear memory (INGEST-01).
    tree?.delete()
    parser.delete()
  }
}
