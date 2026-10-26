import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Parser, Language, Query, Tree, type Node, type QueryMatch } from 'web-tree-sitter'
import { LANGUAGE_GRAMMARS, scopedSymbol, withoutDefinedPrototypes, type NewLanguage, type ScopeRules } from './extraction-languages.js'

const require = createRequire(import.meta.url)

/**
 * Version of everything that turns a repository file's content into its
 * imports and symbols (#453): the grammars and queries below, the symbol
 * kinds and `symbolOf`, and in extraction-queue.ts the minified-file rule
 * and the embed-budget order (the blocks and their texts are embed-key.ts
 * `CHUNK_VERSION`'s). Bump it with any change to those: it is part of
 * the `extract` job key and stored on `repository_files.extractor_version`,
 * so the next boot re-extracts every file another version produced (old rows
 * stay searchable until each file's new result commits).
 * 1: tree-sitter TypeScript, JavaScript, Python, Go, imports with their line
 * (#558). Rows extracted before #453 carry 0.
 * 2: `.tsx` parsed with the TSX grammar (#449); `.mts`/`.cts` extracted as
 * TypeScript, and `.mts/.cts/.mjs/.cjs` import candidates (#451).
 * 3: definitions as code writes them (#450): arrow-function and
 * function-expression consts, generators, abstract classes, enums,
 * namespaces, exported consts, anonymous default exports, `exports.f =`,
 * methods with their `parent` (TS/JS classes, Python classes, Go receivers);
 * top-level only, so nested functions are no longer symbols; symbol embed
 * text names a method's parent, and the per-file embed budget goes to
 * exported, then other top-level symbols before methods.
 * 4: TS/TSX/JS imports also from `export ... from`, `import('x')` and
 * `require('x')` with a literal specifier, and TypeScript `import x =
 * require('x')` (#466). No block text changes, so no vector is embedded again.
 * 5: Rust, Java, C, C++, C#, Kotlin, Ruby and PHP symbols and imports
 * (extraction-languages.ts), and Markdown/HTML heading sections (outline.ts)
 * (#464); a file whose language label changed (`.kt`, `.md`, ...) is
 * relabelled. Unchanged texts keep their vectors: the file blocks of these
 * files are not embedded again, only their new symbol blocks (sections are
 * outline blocks, never embedded).
 * 6: identifier lexemes for the keyword channel (#455, search/identifiers.ts):
 * `repository_files.keyword_fts` and symbol blocks' `keywords` (migration 0052).
 * No block text changes, so no vector is embedded again.
 */
export const EXTRACTOR_VERSION = 6

/**
 * What a symbol declares (#450; the contract more languages, #464, and the
 * symbol/edge table, #469, build on). `method`: a function declared in a
 * class body (or on a Go receiver type, in a Rust `impl`), its class in
 * `parent`. `variable`: an exported module-level binding that is not a
 * function or a class (and in #464's languages a constant, or a public or
 * static field with its class in `parent`). `namespace`: a TypeScript
 * `namespace` (a Rust `mod`, a C++ namespace, a Ruby module), its members
 * carrying it in `parent`.
 */
export const SYMBOL_KINDS = ['function', 'class', 'interface', 'type', 'enum', 'method', 'variable', 'namespace'] as const
export type SymbolKind = (typeof SYMBOL_KINDS)[number]

export interface ExtractedSymbol {
  /** The bare name (`save`, not `Store.save`); `default` for an anonymous default export. */
  name: string
  kind: SymbolKind
  startLine: number
  endLine: number
  /** The class of a method, or the namespace of a namespace member; absent at module level. */
  parent?: string
  /**
   * Exported from its module (an `export` or `exports.f =` in TS/JS, a
   * capitalised Go name, a Python name without a leading `_`); never for a
   * method. Not stored: it orders the per-file embed budget.
   */
  exported: boolean
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

type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'go' | NewLanguage

const SUPPORTED = new Set<string>(['typescript', 'javascript', 'python', 'go', ...Object.keys(LANGUAGE_GRAMMARS)])

export function isSupportedLanguage(language: string | null): language is SupportedLanguage {
  return language !== null && SUPPORTED.has(language)
}

const wasmPath = (pkg: string, file: string): string =>
  join(dirname(require.resolve(`${pkg}/package.json`)), file)

interface GrammarConfig {
  wasm: string
  /** `@src` captures; none: the language's imports name no file (C# `using`). */
  importQuery?: string
  /** The specifiers of an `@src` node whose text is not just one (a Rust `use` tree, a Java `import`); none: not an import of a file. */
  importTarget?: (node: Node) => string[]
  /**
   * Candidate declarations, `@decl.<kind>` with their `@name`, wherever they
   * are: `symbolOf` keeps those at module level (or in a module-level
   * namespace or class) and decides the kind of `@decl.binding`
   * (`const f = ...`), `@decl.default` (`export default () => ...`) and
   * `@decl.exports` (`exports.f = ...`). With `scopes` (#464's grammars),
   * extraction-languages.ts `scopedSymbol` does instead.
   */
  symbolQuery: string
  /** Languages that export by naming convention rather than by an `export` keyword. */
  exportedName?: (name: string) => boolean
  scopes?: ScopeRules
}

/** A grammar: the language's own, or TSX for a `.tsx` file (#449). */
type Grammar = SupportedLanguage | 'tsx'

/**
 * The module specifiers of a TS/TSX/JS file (#466): `import ... from`,
 * `export ... from`, and `import()` / `require()` whose specifier is a
 * literal (a string, or a template without `${}`); `require` with exactly one.
 */
const JAVASCRIPT_IMPORT_PATTERNS = `
        (import_statement source: (string (string_fragment) @src))
        (export_statement source: (string (string_fragment) @src))
        (call_expression
          function: (import)
          arguments: (arguments . [(string (string_fragment) @src) (template_string . (string_fragment) @src .)]))
        (call_expression
          function: (identifier) @require
          arguments: (arguments . [(string (string_fragment) @src) (template_string . (string_fragment) @src .)] .)
          (#eq? @require "require"))`
/** JavaScript's, plus TypeScript's `import fs = require('fs')`. */
const TYPESCRIPT_IMPORT_QUERY = `[${JAVASCRIPT_IMPORT_PATTERNS}
        (import_require_clause source: (string (string_fragment) @src))
      ]`
const TYPESCRIPT_SYMBOL_QUERY = `
      [
        (function_declaration name: (identifier) @name) @decl.function
        (generator_function_declaration name: (identifier) @name) @decl.function
        (class_declaration name: (type_identifier) @name) @decl.class
        (abstract_class_declaration name: (type_identifier) @name) @decl.class
        (interface_declaration name: (type_identifier) @name) @decl.interface
        (type_alias_declaration name: (type_identifier) @name) @decl.type
        (enum_declaration name: (identifier) @name) @decl.enum
        (internal_module name: (_) @name) @decl.namespace
        (module name: (_) @name) @decl.namespace
        (method_definition name: (_) @name) @decl.method
        (abstract_method_signature name: (_) @name) @decl.method
        (public_field_definition name: (_) @name value: [(arrow_function) (function_expression) (generator_function)]) @decl.method
        (variable_declarator name: (identifier) @name) @decl.binding
        (export_statement value: [(arrow_function) (function_expression) (generator_function) (class)] @decl.default)
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
    importQuery: `[${JAVASCRIPT_IMPORT_PATTERNS}\n      ]`,
    // CommonJS: `exports.f = () => {}` and `module.exports.f = function () {}`
    // define `f`; `module.exports = { f }` only re-lists names defined above.
    symbolQuery: `
      [
        (function_declaration name: (identifier) @name) @decl.function
        (generator_function_declaration name: (identifier) @name) @decl.function
        (class_declaration name: (identifier) @name) @decl.class
        (method_definition name: (_) @name) @decl.method
        (field_definition property: (_) @name value: [(arrow_function) (function_expression) (generator_function)]) @decl.method
        (variable_declarator name: (identifier) @name) @decl.binding
        (export_statement value: [(arrow_function) (function_expression) (generator_function) (class)] @decl.default)
        (assignment_expression
          left: (member_expression object: (_) @exports property: (property_identifier) @name)
          right: [(arrow_function) (function_expression) (generator_function)]) @decl.exports
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
    // A `def` in a class body becomes a method (`symbolOf`).
    symbolQuery: `
      [
        (function_definition name: (identifier) @name) @decl.function
        (class_definition name: (identifier) @name) @decl.class
      ]
    `,
    exportedName: (name) => !name.startsWith('_'),
  },
  go: {
    wasm: wasmPath('tree-sitter-go', 'tree-sitter-go.wasm'),
    importQuery: `(import_spec path: (interpreted_string_literal (interpreted_string_literal_content) @src))`,
    symbolQuery: `
      [
        (function_declaration name: (identifier) @name) @decl.function
        (method_declaration receiver: (parameter_list) @receiver name: (field_identifier) @name) @decl.method
        (type_declaration (type_spec name: (type_identifier) @name)) @decl.type
      ]
    `,
    exportedName: (name) => /^\p{Lu}/u.test(name),
  },
  // #464's grammars, each loaded the first time a file of its language is extracted.
  ...(Object.fromEntries(
    Object.entries(LANGUAGE_GRAMMARS).map(([language, { wasm, ...grammar }]) => [language, { ...grammar, wasm: wasmPath(...wasm) }]),
  ) as Record<NewLanguage, GrammarConfig>),
}

const SYMBOL_KIND_BY_CAPTURE: Record<string, SymbolKind> = {
  'decl.function': 'function',
  'decl.class': 'class',
  'decl.interface': 'interface',
  'decl.type': 'type',
  'decl.enum': 'enum',
  'decl.namespace': 'namespace',
  'decl.method': 'method',
}

/** The module (file) node of each grammar. */
const ROOTS = new Set(['program', 'module', 'source_file'])
/**
 * What may stand between a module-level declaration and the module: `export`,
 * `declare`, Python decorators, the `const`/`let`/`var` statement around a
 * declarator, the statement around a TypeScript `namespace`.
 */
const WRAPPERS = new Set(['export_statement', 'ambient_declaration', 'decorated_definition', 'lexical_declaration', 'variable_declaration', 'expression_statement'])
/** TypeScript `namespace N {}`, and `module N {}` / `declare module "x" {}`. */
const NAMESPACES = new Set(['internal_module', 'module'])
const CLASSES = new Set(['class_declaration', 'abstract_class_declaration', 'class', 'class_definition'])
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'generator_function'])

/** A declared name; a module's quoted name (`declare module "frida"`) without its quotes. */
function nameText(node: Node | null | undefined): string | undefined {
  return node?.type === 'string' ? node.text.slice(1, -1) : node?.text
}

interface Scope {
  /** The module-level namespace (or ambient module, or `global`) a declaration is in. */
  parent?: string
  exported: boolean
}

/**
 * Where a declaration sits when it counts as a symbol: at module level, or
 * directly in a module-level TypeScript namespace, ambient module or
 * `declare global {}`. Null inside any other body or block: a function
 * nested in a function is not a symbol (#450).
 */
function moduleScope(node: Node): Scope | null {
  let exported = false
  let p = node.parent
  while (p && WRAPPERS.has(p.type)) {
    if (p.type === 'export_statement') exported = true
    p = p.parent
  }
  if (!p) return null
  if (ROOTS.has(p.type)) return { exported }
  const container = p.type === 'statement_block' ? p.parent : null
  if (!container) return null
  // `declare global { ... }` is a block straight in its `declare`.
  const parent = container.type === 'ambient_declaration' ? 'global' : NAMESPACES.has(container.type) ? nameText(container.childForFieldName('name')) : undefined
  const outer = parent ? moduleScope(container) : null
  return outer && outer.parent === undefined ? { parent, exported } : null
}

/** The class a member is declared in, when that class is itself a symbol: its name (`default` for `export default class {}`). */
function enclosingClass(member: Node): string | null {
  let body = member.parent
  if (body?.type === 'decorated_definition') body = body.parent
  const cls = body?.parent
  if (!body || !cls || !CLASSES.has(cls.type) || (body.type !== 'class_body' && body.type !== 'block')) return null
  const named = cls.childForFieldName('name')
  if (named) return moduleScope(cls) ? named.text : null
  // A class expression: `const Store = class {}` or `export default class {}`.
  const declarator = cls.parent?.type === 'variable_declarator' ? cls.parent : null
  if (declarator) return moduleScope(declarator) ? (declarator.childForFieldName('name')?.text ?? null) : null
  return cls.parent?.type === 'export_statement' && moduleScope(cls) ? 'default' : null
}

/** Lines are 1-based and inclusive. */
function lines(node: Node): { startLine: number; endLine: number } {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
}

/** A query match turned into a symbol, or null when it is not one (nested, unexported const, not CommonJS `exports`). */
function symbolOf(match: QueryMatch, config: GrammarConfig): ExtractedSymbol | null {
  const capture = (name: string) => match.captures.find((c) => c.name === name)?.node
  const decl = match.captures.find((c) => c.name.startsWith('decl.'))
  if (!decl) return null
  const node = decl.node
  const name = nameText(capture('name'))
  const exportedName = (n: string, scope: Scope) => (config.exportedName ? config.exportedName(n) : scope.exported)

  switch (decl.name) {
    case 'decl.binding': {
      const scope = moduleScope(node)
      const value = node.childForFieldName('value')
      if (!scope || !name) return null
      const exported = exportedName(name, scope)
      const kind: SymbolKind | null =
        value && FUNCTION_VALUES.has(value.type) ? 'function' : value?.type === 'class' ? 'class' : exported ? 'variable' : null
      return kind ? { name, kind, ...lines(node), ...(scope.parent ? { parent: scope.parent } : {}), exported } : null
    }
    case 'decl.default': {
      const scope = moduleScope(node)
      if (!scope) return null
      const kind: SymbolKind = node.type === 'class' ? 'class' : 'function'
      return { name: node.childForFieldName('name')?.text ?? 'default', kind, ...lines(node), exported: true }
    }
    case 'decl.exports': {
      const target = capture('exports')?.text
      if (!name || (target !== 'exports' && target !== 'module.exports') || !moduleScope(node)) return null
      return { name, kind: 'function', ...lines(node), exported: true }
    }
  }

  const kind = SYMBOL_KIND_BY_CAPTURE[decl.name]
  if (!kind || !name) return null
  // A Go method's parent is its receiver's type (`*Repo[T]` -> `Repo`).
  const receiver = capture('receiver')
  if (receiver) {
    const type = receiver.descendantsOfType('type_identifier')[0]?.text
    return type ? { name, kind, ...lines(node), parent: type, exported: false } : null
  }
  // A method, or a Python `def` in a class body.
  const cls = kind === 'method' || kind === 'function' ? enclosingClass(node) : null
  if (cls !== null) return { name, kind: 'method', ...lines(node), parent: cls, exported: false }
  if (kind === 'method') return null
  const scope = moduleScope(node)
  if (!scope) return null
  return { name, kind, ...lines(node), ...(scope.parent ? { parent: scope.parent } : {}), exported: exportedName(name, scope) }
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
 * Tree-sitter, file-level extraction (spec 9): import edges + cheap
 * "contains" symbols, those at module level and the methods of module-level
 * classes (#450), by line. `path` picks the grammar where a language has several.
 */
export async function extractStructure(language: string, content: string, path: string): Promise<ExtractionResult> {
  if (!isSupportedLanguage(language)) {
    throw new Error(`unsupported language for extraction: ${language}`)
  }
  // The grammar comes from the extension, not the label: a `.tsx` file is
  // labelled `typescript` (language.ts) but JSX only parses with TSX, and TSX
  // cannot parse the `<T>value` casts `.ts/.mts/.cts` allow. A `.h` header is
  // labelled `c` but may be C++ (most C++ projects name headers `.h`): the C++
  // grammar reads C declarations alike and also C++ classes and namespaces.
  const grammar: Grammar =
    language === 'typescript' && /\.tsx$/i.test(path) ? 'tsx' : language === 'c' && /\.h$/i.test(path) ? 'cpp' : language
  const config = GRAMMARS[grammar]
  const lang = await loadLanguage(grammar)
  const parser = new Parser()
  parser.setLanguage(lang)

  let tree: Tree | null = null
  try {
    tree = parser.parse(content)
    if (!tree) return { imports: [], symbols: [] }

    const imports: ExtractedImport[] = []
    if (config.importQuery) {
      for (const match of getCompiledQuery(lang, grammar, 'import', config.importQuery).matches(tree.rootNode)) {
        for (const capture of match.captures) {
          if (capture.name !== 'src') continue
          const line = capture.node.startPosition.row + 1
          for (const target of config.importTarget ? config.importTarget(capture.node) : [capture.node.text]) imports.push({ target, line })
        }
      }
    }

    const matches = getCompiledQuery(lang, grammar, 'symbol', config.symbolQuery).matches(tree.rootNode)
    const { scopes } = config
    const symbols = scopes
      ? withoutDefinedPrototypes(matches.flatMap((match) => scopedSymbol(match, scopes) ?? []))
      : matches.flatMap((match) => symbolOf(match, config) ?? [])
    // Stable: declarations sharing a line (`export const a = 1, b = 2`) keep their order.
    symbols.sort((a, b) => a.startLine - b.startLine)

    return { imports, symbols }
  } finally {
    // ponytail: explicitly delete Tree and Parser to release WebAssembly linear memory (INGEST-01).
    tree?.delete()
    parser.delete()
  }
}
