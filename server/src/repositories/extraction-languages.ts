/**
 * The grammars #464 added: Rust, Java, C, C++, C#, Kotlin, Ruby and PHP, on
 * the #450 symbol contract (extraction.ts `SymbolKind`). Their queries name
 * candidate declarations (`@decl.<kind>` with their `@name`); `scopedSymbol`
 * keeps those at module level, in a namespace, or directly in a class that is
 * itself one of those, from each grammar's `ScopeRules`. A declaration nested
 * in a function body, or in a nested class, is not a symbol.
 *
 * How the languages map onto the kinds: a Rust struct or union, a PHP trait
 * and a Kotlin `object` are `class`; a Rust trait is an `interface`; a C
 * `typedef`, a C++ `using` alias, a C# delegate and a Kotlin `typealias` are
 * `type`; a Rust `mod` with a body, a C++ namespace and a Ruby module are
 * `namespace`s whose members carry them in `parent` (as TypeScript's do), and
 * an `impl` block's functions are methods of its type. A C# or PHP namespace
 * is a symbol but no `parent`: a file-scoped one (`namespace X;`) holds no
 * declarations in its syntax tree, so a braced one does not either, and a
 * type is named the same in both forms. A Ruby `def` in a module is a method
 * of the module. Rust `const`/`static` are `variable`s; Java, C# and Kotlin
 * fields (C# properties too) are `variable`s of their class when public or
 * static (Kotlin: not private or protected), module-level Kotlin properties
 * when not private.
 */
import type { Node, QueryMatch } from 'web-tree-sitter'
import type { ExtractedSymbol, SymbolKind } from './extraction.js'

export interface ScopeRules {
  /**
   * Nodes between a declaration and the module, namespace or class it
   * belongs to: bodies, C++ `template <...>`, C preprocessor conditionals, a
   * namespace the language does not name its members by.
   */
  transparent: ReadonlySet<string>
  /** Nodes whose members are symbols: a class's methods carry it in `parent`, and so do a namespace's members. */
  containers: Readonly<Record<string, 'class' | 'namespace'>>
  /** Visible outside its file or module, for a declaration at module or namespace level. */
  exported: (decl: Node) => boolean
  /** A field (`@decl.field`) of a class that is a symbol: a public or static one. */
  visibleField?: (decl: Node) => boolean
  /** The kind of a `@decl.class` the node makes another one (Kotlin `interface`, `enum class`). */
  classKind?: (decl: Node) => SymbolKind
  /** Ruby: a `def` (or `def self.x`) in a module is one of its methods. */
  namespaceMethods?: boolean
}

/** A symbol and whether it came from a C/C++ prototype (`@prototype`), dropped when the file also defines it. */
export interface ScopedSymbol {
  symbol: ExtractedSymbol
  prototype: boolean
}

/** The module (file) node of the #464 grammars. */
const ROOTS = new Set(['source_file', 'program', 'translation_unit', 'compilation_unit'])

const KIND_BY_CAPTURE: Record<string, SymbolKind> = {
  'decl.function': 'function',
  'decl.method': 'method',
  'decl.class': 'class',
  'decl.interface': 'interface',
  'decl.enum': 'enum',
  'decl.type': 'type',
  'decl.namespace': 'namespace',
  'decl.variable': 'variable',
}

/** The words of a node's modifier children: `public static`, `pub(crate)`, `static`, `private`, annotations. */
function modifiers(node: Node): Set<string> {
  const words = new Set<string>()
  for (const child of node.children) {
    if (child && MODIFIER_NODES.has(child.type)) for (const word of child.text.split(/\s+/)) words.add(word)
  }
  return words
}
const MODIFIER_NODES = new Set(['modifiers', 'modifier', 'visibility_modifier', 'storage_class_specifier'])

/** A type's bare name: `Store` for `Store<T>`, `&'a Store`, `a::Store`, `Store<T>::` scopes. */
function typeName(node: Node | null): string | null {
  if (!node) return null
  switch (node.type) {
    case 'generic_type':
    case 'reference_type':
    case 'pointer_type':
      return typeName(node.childForFieldName('type'))
    case 'template_type':
    case 'scoped_type_identifier':
    case 'qualified_identifier':
      return typeName(node.childForFieldName('name'))
    default:
      return node.text
  }
}

/** A container's name: its `name` (the last part of `class A::B {}`), or the type an `impl` block is for; null for an anonymous namespace. */
function containerName(node: Node): string | null {
  const name = node.childForFieldName('name')
  return name ? (name.type === 'qualified_identifier' ? typeName(name) : name.text) : typeName(node.childForFieldName('type'))
}

type Place = { at: 'module' } | { at: 'namespace' | 'class'; name: string }

/**
 * Where a declaration is when it can be a symbol: at module level, in a
 * namespace (at any depth), or directly in a class at one of those two
 * places. Null inside a body or a nested class.
 */
function placeOf(node: Node, rules: ScopeRules): Place | null {
  let p = node.parent
  while (p && rules.transparent.has(p.type)) p = p.parent
  if (!p) return null
  if (ROOTS.has(p.type)) return { at: 'module' }
  const role = rules.containers[p.type]
  if (!role) return null
  const name = containerName(p)
  // C++ `namespace { ... }`: its members are where it is.
  if (!name) return role === 'namespace' ? placeOf(p, rules) : null
  const outer = placeOf(p, rules)
  return outer && outer.at !== 'class' ? { at: role, name } : null
}

/** Lines are 1-based and inclusive. */
function lines(node: Node): { startLine: number; endLine: number } {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
}

/** A query match of a #464 grammar turned into a symbol, or null when it is not one. */
export function scopedSymbol(match: QueryMatch, rules: ScopeRules): ScopedSymbol | null {
  const decl = match.captures.find((c) => c.name.startsWith('decl.'))
  let nameNode = match.captures.find((c) => c.name === 'name')?.node
  // `CURL_EXTERN CURLcode f(...)` in a `.h` read by the C++ grammar: the macro makes `CURLcode f` a
  // qualified name with a MISSING `::`. It is the function `f`, not a method of `CURLcode`.
  if (nameNode?.type === 'qualified_identifier' && nameNode.children.some((c) => c?.isMissing)) nameNode = nameNode.childForFieldName('name') ?? nameNode
  if (!decl || !nameNode) return null
  const node = decl.node
  const prototype = match.captures.some((c) => c.name === 'prototype')
  const place = placeOf(node, rules)
  if (!place) return null
  const symbol = (s: Omit<ExtractedSymbol, 'startLine' | 'endLine'>): ScopedSymbol => ({ symbol: { ...s, ...lines(node) }, prototype })

  // C++ `T Store<T>::load() {}`: a method of `Store` defined outside its class. In
  // `void ns::Store::load() {}` the scope nests (`ns` :: (`Store` :: `load`)): the class is the innermost scope.
  if (nameNode.type === 'qualified_identifier') {
    let qualified = nameNode
    for (let inner = qualified.childForFieldName('name'); inner?.type === 'qualified_identifier'; inner = qualified.childForFieldName('name')) qualified = inner
    const scope = typeName(qualified.childForFieldName('scope'))
    const name = typeName(qualified)
    return scope && name && place.at !== 'class' ? symbol({ name, kind: 'method', parent: scope, exported: false }) : null
  }
  const name = nameNode.text
  const field = decl.name === 'decl.field'
  let kind: SymbolKind | undefined = field ? 'variable' : KIND_BY_CAPTURE[decl.name]
  if (kind === 'class' && rules.classKind) kind = rules.classKind(node)
  if (!kind) return null
  const callable = kind === 'function' || kind === 'method'

  if (place.at === 'class') {
    if (callable) return symbol({ name, kind: 'method', parent: place.name, exported: false })
    // A public or static field; not a nested type or an associated constant.
    return field && rules.visibleField?.(node) ? symbol({ name, kind, parent: place.name, exported: false }) : null
  }
  if (place.at === 'namespace' && callable && rules.namespaceMethods) return symbol({ name, kind: 'method', parent: place.name, exported: false })
  // A method form outside a class (Ruby `def self.x` at the top) is none.
  if (kind === 'method') return null
  const exported = rules.exported(node)
  if (field && !exported) return null
  return symbol({ name, kind, ...(place.at === 'namespace' ? { parent: place.name } : {}), exported })
}

/** Drops a C/C++ prototype whose function the file defines too (a forward declaration, an in-class declaration). */
export function withoutDefinedPrototypes(found: ScopedSymbol[]): ExtractedSymbol[] {
  const key = (s: ExtractedSymbol) => `${s.parent ?? ''}\u001f${s.name}`
  const defined = new Set(found.filter((f) => !f.prototype).map((f) => key(f.symbol)))
  return found.filter((f) => !f.prototype || !defined.has(key(f.symbol))).map((f) => f.symbol)
}

// ---------------------------------------------------------------- grammars

/** A path that names no module of its own: `crate`, `self`, `super`, `super::super`. */
const RUST_ROOT_PATH = /^(?:crate|self|super(?:::super)*)$/

/**
 * A `use` tree as the module paths it imports from: `crate::store` for
 * `crate::store::{A, B}`, the path before ` as X` or `::*`. A list straight
 * under `crate`, `self` or `super` imports one module per item
 * (`crate::{a, b::C}` gives `crate::a`, `crate::b::C`). A `mod x;`
 * declaration's name: the module file it loads.
 */
function rustUseTargets(node: Node): string[] {
  const text = (n: Node | null | undefined) => n?.text.replace(/\s+/g, '') ?? ''
  switch (node.type) {
    case 'scoped_use_list': {
      const path = text(node.childForFieldName('path'))
      if (!RUST_ROOT_PATH.test(path)) return path ? [path] : []
      const items = node.childForFieldName('list')?.namedChildren ?? []
      // `self` (or `self as x`) in the list names the root itself, no module of its own.
      return items.flatMap((item) => (item ? rustUseTargets(item).filter((t) => t !== 'self').map((t) => `${path}::${t}`) : []))
    }
    case 'use_as_clause':
      return [text(node.childForFieldName('path'))].filter(Boolean)
    case 'use_wildcard':
      return [text(node.namedChildren[0])].filter(Boolean)
    case 'use_list':
      return []
    default:
      return [text(node)].filter(Boolean)
  }
}

/** A Java or Kotlin import as the name it imports, `a.b.*` for a wildcard. */
function jvmImportTarget(node: Node): string[] {
  const name = node.namedChildren.find((c) => c?.type === 'scoped_identifier' || c?.type === 'qualified_identifier' || c?.type === 'identifier')
  if (!name) return []
  return [node.children.some((c) => c?.type === 'asterisk' || c?.type === '*') ? `${name.text}.*` : name.text]
}

export interface LanguageGrammar {
  /** The `.wasm` file in its npm package. */
  wasm: [pkg: string, file: string]
  /** `@src`: the import's node; `importTarget` turns it into the specifiers when it is not the specifier's text. None: C#, whose `using` names namespaces, not files. */
  importQuery?: string
  importTarget?: (node: Node) => string[]
  symbolQuery: string
  scopes: ScopeRules
}

/**
 * Functions and prototypes in C and C++: the name inside a (pointer or
 * reference) function declarator, never a function pointer's `(*f)`. C++
 * adds `Class::method`, destructors and operators, references, and class
 * members.
 */
function cFunctions(cpp: boolean): string {
  const name = cpp ? '[(identifier) (field_identifier) (qualified_identifier) (destructor_name) (operator_name)] @name' : '(identifier) @name'
  // `T f()`, `T *f()`, `T **f()`.
  const declarators = [
    `(function_declarator declarator: ${name})`,
    `(pointer_declarator declarator: (function_declarator declarator: ${name}))`,
    `(pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: ${name})))`,
  ]
  if (cpp) {
    declarators.push(`(reference_declarator (function_declarator declarator: ${name}))`)
    // `CURL_EXTERN T *f(...)` in a `.h` read by the C++ grammar: the macro makes it a qualified name with a
    // MISSING `::` around a pointer declarator (see `scopedSymbol` for the non-pointer case).
    declarators.push('(qualified_identifier name: (pointer_type_declarator declarator: (function_declarator declarator: (type_identifier) @name)))')
  }
  return declarators
    .flatMap((d) => [
      `(function_definition declarator: ${d}) @decl.function`,
      `(declaration declarator: ${d}) @decl.function @prototype`,
      ...(cpp ? [`(field_declaration declarator: ${d}) @decl.function @prototype`] : []),
    ])
    .join('\n        ')
}
/** `#include "local.h"`; never `<system.h>`. */
const C_INCLUDE_QUERY = '(preproc_include path: (string_literal (string_content) @src))'
const C_TRANSPARENT = ['preproc_ifdef', 'preproc_if', 'preproc_else', 'preproc_elif', 'preproc_elifdef']
const notStatic = (decl: Node) => !modifiers(decl).has('static')
const publicOrStatic = (decl: Node) => {
  const words = modifiers(decl)
  return words.has('public') || words.has('static')
}
const kotlinVisible = (decl: Node) => {
  const words = modifiers(decl)
  return !words.has('private') && !words.has('protected')
}

export type NewLanguage = 'rust' | 'java' | 'c' | 'cpp' | 'csharp' | 'kotlin' | 'ruby' | 'php'

export const LANGUAGE_GRAMMARS: Record<NewLanguage, LanguageGrammar> = {
  rust: {
    wasm: ['tree-sitter-rust', 'tree-sitter-rust.wasm'],
    // `use` trees, and `mod x;` (a module whose body is another file).
    importQuery: '[(use_declaration argument: (_) @src) (mod_item !body name: (identifier) @src)]',
    importTarget: rustUseTargets,
    symbolQuery: `
      [
        (function_item name: (identifier) @name) @decl.function
        (function_signature_item name: (identifier) @name) @decl.method
        (struct_item name: (type_identifier) @name) @decl.class
        (union_item name: (type_identifier) @name) @decl.class
        (enum_item name: (type_identifier) @name) @decl.enum
        (trait_item name: (type_identifier) @name) @decl.interface
        (type_item name: (type_identifier) @name) @decl.type
        (mod_item name: (identifier) @name body: (declaration_list)) @decl.namespace
        (const_item name: (identifier) @name) @decl.variable
        (static_item name: (identifier) @name) @decl.variable
      ]
    `,
    scopes: {
      transparent: new Set(['declaration_list']),
      containers: { impl_item: 'class', trait_item: 'class', mod_item: 'namespace' },
      exported: (decl) => decl.children.some((c) => c?.type === 'visibility_modifier'),
    },
  },
  java: {
    wasm: ['tree-sitter-java', 'tree-sitter-java.wasm'],
    importQuery: '(import_declaration) @src',
    importTarget: jvmImportTarget,
    symbolQuery: `
      [
        (class_declaration name: (identifier) @name) @decl.class
        (record_declaration name: (identifier) @name) @decl.class
        (interface_declaration name: (identifier) @name) @decl.interface
        (annotation_type_declaration name: (identifier) @name) @decl.interface
        (enum_declaration name: (identifier) @name) @decl.enum
        (method_declaration name: (identifier) @name) @decl.method
        (constructor_declaration name: (identifier) @name) @decl.method
        (compact_constructor_declaration name: (identifier) @name) @decl.method
        (field_declaration declarator: (variable_declarator name: (identifier) @name)) @decl.field
        (constant_declaration declarator: (variable_declarator name: (identifier) @name)) @decl.field
      ]
    `,
    scopes: {
      transparent: new Set(['class_body', 'interface_body', 'enum_body', 'enum_body_declarations', 'annotation_type_body']),
      containers: {
        class_declaration: 'class',
        record_declaration: 'class',
        interface_declaration: 'class',
        annotation_type_declaration: 'class',
        enum_declaration: 'class',
      },
      exported: (decl) => modifiers(decl).has('public'),
      // An interface's constants are public and static.
      visibleField: (decl) => decl.type === 'constant_declaration' || publicOrStatic(decl),
    },
  },
  c: {
    wasm: ['tree-sitter-c', 'tree-sitter-c.wasm'],
    importQuery: C_INCLUDE_QUERY,
    symbolQuery: `
      [${cFunctions(false)}
        (struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @decl.class
        (union_specifier name: (type_identifier) @name body: (field_declaration_list)) @decl.class
        (enum_specifier name: (type_identifier) @name body: (enumerator_list)) @decl.enum
        (type_definition declarator: (type_identifier) @name) @decl.type
      ]
    `,
    scopes: {
      transparent: new Set([...C_TRANSPARENT, 'linkage_specification', 'declaration_list']),
      containers: {},
      exported: notStatic,
    },
  },
  cpp: {
    wasm: ['tree-sitter-cpp', 'tree-sitter-cpp.wasm'],
    importQuery: C_INCLUDE_QUERY,
    symbolQuery: `
      [${cFunctions(true)}
        (class_specifier name: (type_identifier) @name body: (field_declaration_list)) @decl.class
        (struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @decl.class
        (union_specifier name: (type_identifier) @name body: (field_declaration_list)) @decl.class
        (enum_specifier name: (type_identifier) @name body: (enumerator_list)) @decl.enum
        (type_definition declarator: (type_identifier) @name) @decl.type
        (alias_declaration name: (type_identifier) @name) @decl.type
        (namespace_definition name: (_) @name) @decl.namespace
      ]
    `,
    scopes: {
      transparent: new Set([...C_TRANSPARENT, 'linkage_specification', 'template_declaration', 'declaration_list', 'field_declaration_list']),
      containers: { class_specifier: 'class', struct_specifier: 'class', union_specifier: 'class', namespace_definition: 'namespace' },
      exported: notStatic,
    },
  },
  csharp: {
    wasm: ['tree-sitter-c-sharp', 'tree-sitter-c_sharp.wasm'],
    symbolQuery: `
      [
        (namespace_declaration name: (_) @name) @decl.namespace
        (file_scoped_namespace_declaration name: (_) @name) @decl.namespace
        (class_declaration name: (identifier) @name) @decl.class
        (struct_declaration name: (identifier) @name) @decl.class
        (record_declaration name: (identifier) @name) @decl.class
        (interface_declaration name: (identifier) @name) @decl.interface
        (enum_declaration name: (identifier) @name) @decl.enum
        (delegate_declaration name: (identifier) @name) @decl.type
        (method_declaration name: (identifier) @name) @decl.method
        (constructor_declaration name: (identifier) @name) @decl.method
        (field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @decl.field
        (property_declaration name: (identifier) @name) @decl.field
      ]
    `,
    scopes: {
      transparent: new Set(['namespace_declaration', 'declaration_list']),
      containers: { class_declaration: 'class', struct_declaration: 'class', record_declaration: 'class', interface_declaration: 'class' },
      exported: (decl) => decl.type.endsWith('namespace_declaration') || modifiers(decl).has('public'),
      visibleField: (decl) => {
        const words = modifiers(decl)
        return words.has('public') || words.has('static') || words.has('const')
      },
    },
  },
  kotlin: {
    wasm: ['@tree-sitter-grammars/tree-sitter-kotlin', 'tree-sitter-kotlin.wasm'],
    importQuery: '(import) @src',
    importTarget: jvmImportTarget,
    symbolQuery: `
      [
        (class_declaration name: (identifier) @name) @decl.class
        (object_declaration name: (identifier) @name) @decl.class
        (function_declaration name: (identifier) @name) @decl.function
        (property_declaration (variable_declaration (identifier) @name)) @decl.field
        (type_alias "typealias" . (identifier) @name) @decl.type
      ]
    `,
    scopes: {
      // A companion object's members are its class's.
      transparent: new Set(['class_body', 'enum_class_body', 'companion_object']),
      containers: { class_declaration: 'class', object_declaration: 'class' },
      exported: (decl) => !modifiers(decl).has('private'),
      visibleField: kotlinVisible,
      classKind: (decl) =>
        decl.children.some((c) => c?.type === 'interface') ? 'interface' : modifiers(decl).has('enum') ? 'enum' : 'class',
    },
  },
  ruby: {
    wasm: ['tree-sitter-ruby', 'tree-sitter-ruby.wasm'],
    importQuery: `
      (call
        method: (identifier) @require
        arguments: (argument_list . (string . (string_content) @src .) .)
        (#eq? @require "require_relative"))
    `,
    symbolQuery: `
      [
        (module name: (_) @name) @decl.namespace
        (class name: (_) @name) @decl.class
        (method name: (_) @name) @decl.function
        (singleton_method name: (_) @name) @decl.method
      ]
    `,
    scopes: {
      // `class << self`: its methods are the class's.
      transparent: new Set(['body_statement', 'singleton_class']),
      containers: { class: 'class', module: 'namespace' },
      exported: () => true,
      namespaceMethods: true,
    },
  },
  php: {
    wasm: ['tree-sitter-php', 'tree-sitter-php.wasm'],
    importQuery: `
      [
        (require_expression [(string . (string_content) @src .) (encapsed_string . (string_content) @src .)])
        (require_once_expression [(string . (string_content) @src .) (encapsed_string . (string_content) @src .)])
        (include_expression [(string . (string_content) @src .) (encapsed_string . (string_content) @src .)])
        (include_once_expression [(string . (string_content) @src .) (encapsed_string . (string_content) @src .)])
      ]
    `,
    symbolQuery: `
      [
        (namespace_definition name: (namespace_name) @name) @decl.namespace
        (function_definition name: (name) @name) @decl.function
        (class_declaration name: (name) @name) @decl.class
        (trait_declaration name: (name) @name) @decl.class
        (interface_declaration name: (name) @name) @decl.interface
        (enum_declaration name: (name) @name) @decl.enum
        (method_declaration name: (name) @name) @decl.method
      ]
    `,
    scopes: {
      // `namespace X { ... }`.
      transparent: new Set(['namespace_definition', 'compound_statement', 'declaration_list', 'enum_declaration_list']),
      containers: { class_declaration: 'class', trait_declaration: 'class', interface_declaration: 'class', enum_declaration: 'class' },
      exported: () => true,
    },
  },
}
