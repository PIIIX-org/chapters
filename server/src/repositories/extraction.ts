import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Parser, Language, Query } from 'web-tree-sitter'

const require = createRequire(import.meta.url)

export type SymbolKind = 'function' | 'class' | 'interface' | 'type'

export interface ExtractedSymbol {
  name: string
  kind: SymbolKind
  startLine: number
  endLine: number
}

export interface ExtractionResult {
  imports: string[]
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

const GRAMMARS: Record<SupportedLanguage, GrammarConfig> = {
  typescript: {
    wasm: wasmPath('tree-sitter-typescript', 'tree-sitter-typescript.wasm'),
    importQuery: `(import_statement source: (string (string_fragment) @src))`,
    symbolQuery: `
      [
        (function_declaration name: (identifier) @name) @decl.function
        (class_declaration name: (type_identifier) @name) @decl.class
        (interface_declaration name: (type_identifier) @name) @decl.interface
        (type_alias_declaration name: (type_identifier) @name) @decl.type
      ]
    `,
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
const languageCache = new Map<SupportedLanguage, Language>()

async function loadLanguage(language: SupportedLanguage): Promise<Language> {
  initPromise ??= Parser.init()
  await initPromise
  let lang = languageCache.get(language)
  if (!lang) {
    const wasmBytes = await readFile(GRAMMARS[language].wasm)
    lang = await Language.load(wasmBytes)
    languageCache.set(language, lang)
  }
  return lang
}

/** Tree-sitter, file-level extraction (spec 9): import edges + cheap top-level "contains" symbols. */
export async function extractStructure(language: string, content: string): Promise<ExtractionResult> {
  if (!isSupportedLanguage(language)) {
    throw new Error(`unsupported language for extraction: ${language}`)
  }
  const config = GRAMMARS[language]
  const lang = await loadLanguage(language)
  const parser = new Parser()
  parser.setLanguage(lang)
  const tree = parser.parse(content)
  if (!tree) return { imports: [], symbols: [] }

  const imports: string[] = []
  for (const match of new Query(lang, config.importQuery).matches(tree.rootNode)) {
    for (const capture of match.captures) imports.push(capture.node.text)
  }

  const symbols: ExtractedSymbol[] = []
  for (const match of new Query(lang, config.symbolQuery).matches(tree.rootNode)) {
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
}
