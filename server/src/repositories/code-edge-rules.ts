/**
 * Call, reference and import sites of a parsed file (#469), found on the
 * tree symbol extraction parsed (extraction.ts `extractStructure`), never a
 * second parse. Per grammar, one query (one more walk of the tree) finds:
 * - calls: `@callee`, the called name (a function, a method, a constructor,
 *   a JSX component), with its `@receiver` when it is a member
 *   (`obj.save()`, `Store::new()`), or a `@qualified` path (`a::b::f`) to
 *   split into the two;
 * - type names, `@type` (TS/TSX, Python, Go, Rust, Java);
 * - import statements, `@stmt`, which `bindings` reads into the names the
 *   file's imports bind, each an `import` site, with the import specifier
 *   (`repository_file_imports.target_path`) a use of the name resolves
 *   through.
 * Value references (TS/TSX/JS, Python, Go, Rust, Java) are the names the
 * file defines at module level or imports by name, used as values (a local
 * variable is not one): found by searching the text for those names.
 * C, C++, C#, Kotlin, Ruby and PHP are calls only: no references and no
 * import sites (their includes and requires name files, which resolution
 * searches whole).
 *
 * A site resolves here when it names a definition of its own file (step 1
 * of code-edges.ts' order): a module-level symbol, or a member of the
 * enclosing class through `this`/`self` (or implicitly, in the languages
 * whose methods call each other bare). Otherwise it carries what the
 * other steps look up: `qualified` (`Parent.name`) when the parent is known,
 * `via` when an import binds the name or its qualifier, and `member` for a
 * method of a receiver of unknown type, which is matched by name only.
 */
import type { Node, QueryMatch } from 'web-tree-sitter'
import type { ExtractedSymbol } from './extraction.js'
import { RUST_ROOT_PATH, jvmImportTarget } from './extraction-languages.js'

export interface ExtractedSite {
  kind: 'call' | 'reference' | 'import'
  /** The name looked up: as written, or the imported name an alias stands for. */
  name: string
  /** `Parent.name` when the site names its parent (`this.save()`, `Store.open()`). */
  qualified: string | null
  /** The import specifier binding the name or its qualifier. */
  via: string | null
  /** A member of a receiver whose type is not known: matched by name only. */
  member: boolean
  /** The index in the file's symbols of the definition the site resolves to in its own file, or null. */
  local: number | null
  /** The index in the file's symbols of the innermost symbol around the site, or null at module level. */
  enclosing: number | null
  /** 1-based. */
  line: number
  /** 1-based, in UTF-16 code units. */
  col: number
}

/** A name an import binds in the file. */
interface Binding {
  local: string
  imported: string
  via: string
  /** A module (`import * as ns`, Go's package, Python's `import x`): its members are looked up in the module, it is no symbol. */
  namespace: boolean
  /** `Class.member` for a Java static import. */
  qualified?: string
  /** The bound name as written: the import site. */
  node: Node
}

export interface EdgeRules {
  /**
   * One query, so the edges cost one walk of the tree: calls (`@callee`,
   * with its `@receiver`, or a `@qualified` path to split), type names
   * (`@type`; TS/TSX, Python, Go, Rust, Java) and import statements
   * (`@stmt`, read by `bindings`).
   */
  query: string
  bindings?: (matches: QueryMatch[]) => Binding[]
  /**
   * Node types of a name in value position (TS/TSX/JS, Python, Go, Rust,
   * Java). Only the names the file defines at module level or imports can
   * be references, so they are found by searching the text for those names,
   * not by a query over every identifier. None: calls only.
   */
  valueNames?: ReadonlySet<string>
  /** A receiver that is the enclosing class's instance. */
  self: (receiver: Node, site: Node) => boolean
  /** A bare call may be a method of the enclosing class (Java, C#, Kotlin, C++, Ruby, PHP). */
  implicitSelf?: boolean
  /** Type names of the language or its standard library, never a reference. */
  builtinTypes?: ReadonlySet<string>
  /** Parents of an identifier that binds or declares it, never a reference. */
  notReference?: ReadonlySet<string>
}

const capitalised = (name: string) => /^\p{Lu}/u.test(name)
const thisOrSelf = (receiver: Node) => receiver.type === 'this' || receiver.type === 'self' || receiver.type === 'this_expression'

/** The name a receiver gives as a qualifier: an identifier, or the last segment of a path (`a::Store`); null for an expression. */
function qualifierOf(receiver: Node): { name: string; path: boolean } | null {
  switch (receiver.type) {
    case 'identifier':
    case 'type_identifier':
    case 'constant':
    case 'name':
    case 'namespace_identifier':
    case 'package_identifier':
    case 'simple_identifier':
      return { name: receiver.text, path: false }
    case 'scoped_identifier':
    case 'qualified_identifier':
    case 'scoped_type_identifier':
    case 'qualified_name': {
      const name = receiver.childForFieldName('name') ?? receiver.namedChildren.at(-1)
      return name ? { name: qualifierOf(name)?.name ?? name.text, path: true } : null
    }
    default:
      return null
  }
}

/** Splits `a::b::f` (a C++ qualified identifier, a Rust scoped one) into the called name and its innermost scope. */
function splitQualified(node: Node): { callee: Node; receiver: Node | null } | null {
  let receiver: Node | null = null
  let name: Node | null = node
  while (name && (name.type === 'qualified_identifier' || name.type === 'scoped_identifier')) {
    receiver = name.childForFieldName('scope') ?? name.childForFieldName('path') ?? receiver
    name = name.childForFieldName('name')
  }
  if (name?.type === 'template_function') name = name.childForFieldName('name')
  return name && (name.type === 'identifier' || name.type === 'field_identifier') ? { callee: name, receiver } : null
}

/** The field of its parent a node fills, if any. */
function fieldOf(node: Node): string | null {
  const parent = node.parent
  if (!parent) return null
  for (let i = 0; i < parent.childCount; i++) if (parent.child(i)?.equals(node)) return parent.fieldNameForChild(i)
  return null
}

/** Statements whose names are bound, not used: an identifier under one is never a reference. */
const IMPORT_STATEMENTS = new Set(['import_statement', 'import_from_statement', 'use_declaration', 'import_declaration', 'import_spec'])

function inImport(node: Node): boolean {
  for (let p = node.parent, depth = 0; p && depth < 6; p = p.parent, depth++) {
    if (IMPORT_STATEMENTS.has(p.type)) return true
    if (p.type === 'export_statement') return p.childForFieldName('source') !== null
  }
  return false
}

/**
 * The innermost symbol around each line: symbols nest (a class and its methods), so
 * wider spans are filled first and narrower ones over them. -1: none.
 */
function innermostByLine(symbols: readonly ExtractedSymbol[], lines: number): Int32Array {
  const at = new Int32Array(lines + 1).fill(-1)
  const order = symbols.map((_, i) => i).sort((a, b) => {
    const sa = symbols[a]!, sb = symbols[b]!
    return sb.endLine - sb.startLine - (sa.endLine - sa.startLine) || a - b
  })
  for (const i of order) {
    const s = symbols[i]!
    at.fill(i, Math.max(1, s.startLine), Math.min(lines, s.endLine) + 1)
  }
  return at
}

/**
 * The sites of a parsed file. `symbols` are its symbols in line order (their
 * indexes are the sites' `local` and `enclosing`); `matches` are those of
 * the rules' query on the same tree (extraction.ts runs it with its own).
 */
export function extractSites(
  root: Node,
  content: string,
  rules: EdgeRules,
  symbols: readonly ExtractedSymbol[],
  matches: readonly QueryMatch[],
): ExtractedSite[] {
  const lines = root.endPosition.row + 1
  const enclosingAt = innermostByLine(symbols, lines)
  const moduleLevel = new Map<string, number>()
  const members = new Map<string, number>()
  symbols.forEach((s, i) => {
    const map = s.parent === undefined ? moduleLevel : members
    const key = s.parent === undefined ? s.name : `${s.parent}.${s.name}`
    if (!map.has(key)) map.set(key, i)
  })
  const callMatches: QueryMatch[] = []
  const typeNodes: Node[] = []
  const bindingMatches: QueryMatch[] = []
  for (const match of matches) {
    const type = match.captures.find((c) => c.name === 'type')
    if (type) typeNodes.push(type.node)
    else if (match.captures.some((c) => c.name === 'stmt')) bindingMatches.push(match)
    else callMatches.push(match)
  }
  const bindings = rules.bindings ? rules.bindings(bindingMatches) : []
  const bound = new Map<string, Binding>()
  for (const b of bindings) if (b.local && !bound.has(b.local)) bound.set(b.local, b)

  const sites: ExtractedSite[] = []
  /** Start indexes of the names already a site: one site per name (a callee is not also a reference). */
  const taken = new Set<number>()
  const position = (node: Node) => {
    const line = node.startPosition.row + 1
    const enclosing = enclosingAt[line] ?? -1
    return { line, col: node.startPosition.column + 1, enclosing: enclosing < 0 ? null : enclosing }
  }
  /** The class a site is in: a method's parent, or the class itself. */
  const classAt = (enclosing: number | null): string | null => {
    const s = enclosing === null ? undefined : symbols[enclosing]
    if (!s) return null
    return s.kind === 'class' ? s.name : s.kind === 'method' && s.parent !== undefined ? s.parent : null
  }

  for (const b of bindings) {
    if (b.namespace || taken.has(b.node.startIndex)) continue
    taken.add(b.node.startIndex)
    sites.push({ kind: 'import', name: b.imported, qualified: b.qualified ?? null, via: b.via, member: false, local: null, ...position(b.node) })
  }

  /** A use of `nameNode`, through `receiver` when it is a member. */
  const use = (kind: 'call' | 'reference', nameNode: Node, receiver: Node | null, scoped = false): ExtractedSite => {
    const name = nameNode.text
    const at = position(nameNode)
    type Fields = Pick<ExtractedSite, 'name' | 'qualified' | 'via' | 'member' | 'local'>
    const plain: Fields = { name, qualified: null, via: null, member: false, local: null }
    const site = (fields: Partial<Fields>): ExtractedSite => ({ kind, ...plain, ...fields, ...at })
    const cls = classAt(at.enclosing)
    if (receiver) {
      if (rules.self(receiver, nameNode)) {
        if (!cls) return site({ member: true })
        const qualified = `${cls}.${name}`
        return site({ qualified, local: members.get(qualified) ?? null })
      }
      const qualifier = qualifierOf(receiver)
      if (!qualifier) return site({ member: true })
      const b = bound.get(qualifier.name)
      if (b && (b.namespace || !capitalised(b.local))) return site({ via: b.via })
      if (b) return site({ qualified: `${b.imported}.${name}`, via: b.via })
      if (moduleLevel.has(qualifier.name) || capitalised(qualifier.name)) {
        const qualified = `${qualifier.name}.${name}`
        return site({ qualified, local: members.get(qualified) ?? null })
      }
      // `module::f()`: a path, not a variable.
      return qualifier.path || scoped ? site({}) : site({ member: true })
    }
    if (rules.implicitSelf && cls) {
      const own = members.get(`${cls}.${name}`)
      if (own !== undefined) return site({ qualified: `${cls}.${name}`, local: own })
    }
    const local = moduleLevel.get(name)
    if (local !== undefined) return site({ local })
    const b = bound.get(name)
    if (b) return site({ name: b.imported, qualified: b.qualified ?? null, via: b.via })
    return site({})
  }

  // Calls. Several patterns may match one callee (with and without its receiver): the one with a receiver wins.
  const calls = new Map<number, { callee: Node; receiver: Node | null; scoped: boolean }>()
  for (const match of callMatches) {
    let callee = match.captures.find((c) => c.name === 'callee')?.node ?? null
    let receiver = match.captures.find((c) => c.name === 'receiver')?.node ?? null
    let scoped = false
    const qualified = match.captures.find((c) => c.name === 'qualified')?.node
    if (qualified) {
      const split = splitQualified(qualified)
      if (!split) continue
      ;({ callee, receiver } = split)
      scoped = true
    }
    if (!callee) continue
    const seen = calls.get(callee.startIndex)
    if (!seen || (!seen.receiver && receiver)) calls.set(callee.startIndex, { callee, receiver, scoped })
  }
  for (const [start, { callee, receiver, scoped }] of calls) {
    if (taken.has(start)) continue
    taken.add(start)
    sites.push(use('call', callee, receiver, scoped))
  }

  for (const node of typeNodes) {
    const name = node.text
    const parent = node.parent
    const qualifierField = parent ? QUALIFIED_TYPES[parent.type] : undefined
    if (taken.has(node.startIndex) || name.length < 2 || rules.builtinTypes?.has(name) || (fieldOf(node) === 'name' && !qualifierField)) continue
    taken.add(node.startIndex)
    const receiver = qualifierField ? (parent!.childForFieldName(qualifierField) ?? null) : null
    sites.push(use('reference', node, receiver, true))
  }

  // Values: the names the file defines at module level or imports by name (a module is no symbol), where the text has them.
  const valueNames = rules.valueNames
  const wanted = [...new Set([...moduleLevel.keys(), ...[...bound.values()].filter((b) => !b.namespace).map((b) => b.local)])]
  if (valueNames && wanted.length > 0) {
    const alternatives = wanted.sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const occurrence = new RegExp(`(?<![\\p{L}\\p{N}_$])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_$])`, 'gu')
    for (const m of content.matchAll(occurrence)) {
      const start = m.index
      if (taken.has(start)) continue
      const node = root.descendantForIndex(start, start + m[0].length)
      if (!node || !valueNames.has(node.type) || node.startIndex !== start || node.endIndex !== start + m[0].length) continue
      const parent = node.parent
      if (parent && rules.notReference?.has(parent.type)) continue
      const field = fieldOf(node)
      if (field === 'name' || field === 'attribute' || field === 'field' || field === 'property' || field === 'key' || field === 'alias') continue
      if (inImport(node)) continue
      taken.add(start)
      sites.push(use('reference', node, null))
    }
  }
  return sites
}

/** Type nodes that qualify a type name, and the field holding the qualifier. */
const QUALIFIED_TYPES: Record<string, string> = {
  nested_type_identifier: 'module',
  qualified_type: 'package',
  scoped_type_identifier: 'path',
}

// ---------------------------------------------------------------- bindings

const textOf = (n: Node | null | undefined) => n?.text.replace(/\s+/g, '') ?? ''

/** TS/TSX/JS: `import ... from`, `export {...} from`, `require()` into a name or a destructuring, TypeScript `import x = require()`. */
function jsBindings(matches: QueryMatch[]): Binding[] {
  const out: Binding[] = []
  for (const match of matches) {
    const via = match.captures.find((c) => c.name === 'spec')?.node.text
    const stmt = match.captures.find((c) => c.name === 'stmt')?.node
    if (!via || !stmt) continue
    const named = (name: Node, alias?: Node | null) => out.push({ local: (alias ?? name).text, imported: name.text, via, namespace: false, node: alias ?? name })
    const module = (local: Node) => out.push({ local: local.text, imported: local.text, via, namespace: true, node: local })
    switch (stmt.type) {
      case 'import_statement':
        for (const part of stmt.namedChildren) {
          if (part?.type === 'import_require_clause') {
            const local = part.namedChildren.find((c) => c?.type === 'identifier')
            if (local) module(local)
          }
          if (part?.type !== 'import_clause') continue
          for (const clause of part.namedChildren) {
            if (!clause) continue
            if (clause.type === 'identifier') named(clause)
            else if (clause.type === 'namespace_import') {
              const local = clause.namedChildren.find((c) => c?.type === 'identifier')
              if (local) module(local)
            } else if (clause.type === 'named_imports') {
              for (const spec of clause.namedChildren) {
                const name = spec?.type === 'import_specifier' ? spec.childForFieldName('name') : null
                if (name) named(name, spec!.childForFieldName('alias'))
              }
            }
          }
        }
        break
      case 'export_statement':
        for (const clause of stmt.namedChildren) {
          if (clause?.type !== 'export_clause') continue
          for (const spec of clause.namedChildren) {
            const name = spec?.type === 'export_specifier' ? spec.childForFieldName('name') : null
            if (name) out.push({ local: '', imported: name.text, via, namespace: false, node: name })
          }
        }
        break
      case 'variable_declarator': {
        const pattern = stmt.childForFieldName('name')
        if (pattern?.type === 'identifier') module(pattern)
        else if (pattern?.type === 'object_pattern') {
          for (const part of pattern.namedChildren) {
            if (part?.type === 'shorthand_property_identifier_pattern') named(part)
            else if (part?.type === 'pair_pattern') {
              const key = part.childForFieldName('key')
              const value = part.childForFieldName('value')
              if (key && value?.type === 'identifier') named(key, value)
            }
          }
        }
        break
      }
    }
  }
  return out
}

const JS_BINDINGS = `
  (import_statement source: (string (string_fragment) @spec)) @stmt
  (export_statement source: (string (string_fragment) @spec)) @stmt
  (variable_declarator
    value: (call_expression function: (identifier) @require arguments: (arguments . (string (string_fragment) @spec) .))
    (#eq? @require "require")) @stmt`

/** Python: `import a.b` binds `a` (`as x`: `x`) as a module; `from m import f, g as h` binds names of `m`. */
function pythonBindings(matches: QueryMatch[]): Binding[] {
  const out: Binding[] = []
  for (const match of matches) {
    const stmt = match.captures[0]?.node
    if (!stmt) continue
    if (stmt.type === 'import_statement') {
      for (const name of stmt.childrenForFieldName('name')) {
        if (name?.type === 'dotted_name') {
          const first = name.namedChildren[0]
          if (first) out.push({ local: first.text, imported: first.text, via: name.text, namespace: true, node: first })
        } else if (name?.type === 'aliased_import') {
          const module = name.childForFieldName('name')
          const alias = name.childForFieldName('alias')
          if (module && alias) out.push({ local: alias.text, imported: alias.text, via: module.text, namespace: true, node: alias })
        }
      }
      continue
    }
    const via = stmt.childForFieldName('module_name')?.text
    if (!via) continue
    for (const name of stmt.childrenForFieldName('name')) {
      if (name?.type === 'dotted_name') out.push({ local: name.text, imported: name.text, via, namespace: false, node: name })
      else if (name?.type === 'aliased_import') {
        const imported = name.childForFieldName('name')
        const alias = name.childForFieldName('alias')
        if (imported && alias) out.push({ local: alias.text, imported: imported.text, via, namespace: false, node: alias })
      }
    }
  }
  return out
}

/** Go: an import binds its package, by its name or the path's last segment (a `/vN` major version is skipped). */
function goBindings(matches: QueryMatch[]): Binding[] {
  const out: Binding[] = []
  for (const match of matches) {
    const spec = match.captures.find((c) => c.name === 'stmt')?.node
    const path = match.captures.find((c) => c.name === 'path')?.node
    if (!spec || !path) continue
    const name = spec.childForFieldName('name')
    if (name && name.type !== 'package_identifier') continue // `_` and `.`
    const segments = path.text.split('/')
    const last = /^v\d+$/.test(segments.at(-1)!) && segments.length > 1 ? segments.at(-2)! : segments.at(-1)!
    out.push({ local: name?.text ?? last, imported: name?.text ?? last, via: path.text, namespace: true, node: name ?? path })
  }
  return out
}

/**
 * Rust `use` trees, each name with the specifier extraction-languages.ts `rustUseTargets` gives its import row:
 * the list's path, or under `crate`/`self`/`super` the path of each item. `use x;` binds a module.
 */
function rustUse(node: Node, via: string | null, prefix: string | null): Binding[] {
  const join = (path: string) => (prefix ? `${prefix}::${path}` : path)
  switch (node.type) {
    case 'identifier':
      return node.text === 'self' ? [] : [{ local: node.text, imported: node.text, via: via ?? join(node.text), namespace: via === null && prefix === null, node }]
    case 'scoped_identifier': {
      const name = node.childForFieldName('name')
      return name ? [{ local: name.text, imported: name.text, via: via ?? join(textOf(node)), namespace: false, node: name }] : []
    }
    case 'use_as_clause': {
      const path = node.childForFieldName('path')
      const alias = node.childForFieldName('alias')
      const last = path?.type === 'scoped_identifier' ? path.childForFieldName('name') : path
      return path && alias && last ? [{ local: alias.text, imported: last.text, via: via ?? join(textOf(path)), namespace: false, node: alias }] : []
    }
    case 'scoped_use_list': {
      const path = textOf(node.childForFieldName('path'))
      const items = node.childForFieldName('list')?.namedChildren ?? []
      // Inside a list that already names the module, or under a path that is one: every item is imported by it.
      const itemVia = via ?? (RUST_ROOT_PATH.test(path) ? null : join(path))
      const itemPrefix = itemVia === null ? join(path) : null
      return items.flatMap((item) => (item ? rustUse(item, itemVia, itemPrefix) : []))
    }
    case 'use_list':
      return node.namedChildren.flatMap((item) => (item ? rustUse(item, via, prefix) : []))
    default:
      return []
  }
}

/** Java: `import a.b.C` binds `C`; `import static a.b.C.f` binds `f`, a member of `C`. Wildcards bind nothing. */
function javaBindings(matches: QueryMatch[]): Binding[] {
  const out: Binding[] = []
  for (const match of matches) {
    const stmt = match.captures[0]?.node
    const via = stmt ? jvmImportTarget(stmt)[0] : undefined
    const path = stmt?.namedChildren.find((c) => c?.type === 'scoped_identifier')
    const name = path?.childForFieldName('name')
    if (!stmt || !via || via.endsWith('.*') || !name) continue
    if (stmt.children.some((c) => c?.type === 'static')) {
      const cls = path!.childForFieldName('scope')
      const clsName = cls ? (qualifierOf(cls)?.name ?? cls.text) : null
      if (clsName) out.push({ local: name.text, imported: name.text, qualified: `${clsName}.${name.text}`, via, namespace: false, node: name })
    } else out.push({ local: name.text, imported: name.text, via, namespace: false, node: name })
  }
  return out
}

// ---------------------------------------------------------------- grammars

const TS_BUILTIN_TYPES = new Set([
  'Array', 'ArrayBuffer', 'AsyncGenerator', 'AsyncIterable', 'AsyncIterableIterator', 'AsyncIterator', 'Awaited', 'BigInt', 'Boolean', 'Buffer',
  'ConstructorParameters', 'DataView', 'Date', 'Error', 'Exclude', 'Extract', 'Float32Array', 'Float64Array', 'Function', 'Generator',
  'InstanceType', 'Int32Array', 'Iterable', 'IterableIterator', 'Iterator', 'JSON', 'Lowercase', 'Map', 'NonNullable', 'Number', 'Object',
  'Omit', 'Parameters', 'Partial', 'Pick', 'Promise', 'PromiseLike', 'Readonly', 'ReadonlyArray', 'ReadonlyMap', 'ReadonlySet', 'Record',
  'RegExp', 'Required', 'ReturnType', 'Set', 'String', 'Symbol', 'TemplateStringsArray', 'Uint8Array', 'Uppercase', 'WeakMap', 'WeakSet',
])
const GO_BUILTIN_TYPES = new Set([
  'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64',
  'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
])
const RUST_BUILTIN_TYPES = new Set(['Arc', 'BTreeMap', 'BTreeSet', 'Box', 'Cow', 'HashMap', 'HashSet', 'Option', 'Rc', 'RefCell', 'Result', 'Self', 'String', 'Vec', 'VecDeque'])
const JAVA_BUILTIN_TYPES = new Set([
  'Boolean', 'Byte', 'Character', 'Class', 'Double', 'Exception', 'Float', 'Integer', 'Iterable', 'List', 'Long', 'Map', 'Object', 'Optional',
  'Override', 'RuntimeException', 'Set', 'Short', 'String', 'StringBuilder', 'Throwable', 'Void',
])
const PYTHON_BUILTIN_TYPES = new Set([
  'Any', 'Callable', 'Dict', 'Iterable', 'Iterator', 'List', 'Mapping', 'None', 'Optional', 'Sequence', 'Set', 'Tuple', 'Union', 'bool',
  'bytes', 'dict', 'float', 'int', 'list', 'object', 'set', 'str', 'tuple', 'type',
])

const JS_CALLS = `
  (call_expression function: (identifier) @callee (#not-eq? @callee "require"))
  (call_expression function: (member_expression object: (_) @receiver property: (property_identifier) @callee))
  (new_expression constructor: (identifier) @callee)
  (new_expression constructor: (member_expression object: (_) @receiver property: (property_identifier) @callee))`
/** A JSX element is a call of its component (a capitalised name; a lowercase one is an HTML tag). TSX and JavaScript only. */
const JSX_CALLS = `
  (jsx_opening_element name: (identifier) @callee (#match? @callee "^[A-Z]"))
  (jsx_self_closing_element name: (identifier) @callee (#match? @callee "^[A-Z]"))
  (jsx_opening_element name: (member_expression object: (_) @receiver property: (property_identifier) @callee))
  (jsx_self_closing_element name: (member_expression object: (_) @receiver property: (property_identifier) @callee))`

/** Identifiers that a JS/TS parent binds or declares. */
const JS_NOT_REFERENCE = new Set(['required_parameter', 'optional_parameter', 'jsx_closing_element', 'method_definition', 'import_specifier', 'export_specifier', 'namespace_import', 'import_clause'])
const JS_VALUE_NAMES = new Set(['identifier', 'shorthand_property_identifier'])
const IDENTIFIER = new Set(['identifier'])

const typescript: EdgeRules = {
  query: `${JS_CALLS}\n  (type_identifier) @type\n${JS_BINDINGS}\n  (import_statement (import_require_clause source: (string (string_fragment) @spec))) @stmt`,
  bindings: jsBindings,
  valueNames: JS_VALUE_NAMES,
  self: thisOrSelf,
  builtinTypes: TS_BUILTIN_TYPES,
  notReference: JS_NOT_REFERENCE,
}

export const EDGE_RULES: Record<string, EdgeRules> = {
  typescript,
  tsx: { ...typescript, query: `${typescript.query}\n${JSX_CALLS}` },
  javascript: {
    query: `${JS_CALLS}\n${JSX_CALLS}\n${JS_BINDINGS}`,
    bindings: jsBindings,
    valueNames: JS_VALUE_NAMES,
    self: thisOrSelf,
    notReference: JS_NOT_REFERENCE,
  },
  python: {
    query: `
      (call function: (identifier) @callee)
      (call function: (attribute object: (_) @receiver attribute: (identifier) @callee))
      (type (identifier) @type)
      (class_definition superclasses: (argument_list (identifier) @type))
      [(import_statement) (import_from_statement)] @stmt`,
    bindings: pythonBindings,
    valueNames: IDENTIFIER,
    self: (receiver) => receiver.type === 'identifier' && (receiver.text === 'self' || receiver.text === 'cls'),
    builtinTypes: PYTHON_BUILTIN_TYPES,
    notReference: new Set(['parameters', 'default_parameter', 'typed_parameter', 'typed_default_parameter', 'keyword_argument', 'global_statement', 'nonlocal_statement']),
  },
  go: {
    query: `
      (call_expression function: (identifier) @callee)
      (call_expression function: (selector_expression operand: (_) @receiver field: (field_identifier) @callee))
      (type_identifier) @type
      (import_spec path: (interpreted_string_literal (interpreted_string_literal_content) @path)) @stmt`,
    bindings: goBindings,
    valueNames: IDENTIFIER,
    // A method's receiver variable (`s` in `func (s *Store) Save()`).
    self: (receiver, site) => {
      if (receiver.type !== 'identifier') return false
      let p = site.parent
      while (p && p.type !== 'method_declaration' && p.type !== 'function_declaration' && p.type !== 'source_file') p = p.parent
      const param = p?.type === 'method_declaration' ? p.childForFieldName('receiver')?.namedChildren.find((c) => c?.type === 'parameter_declaration') : null
      return param?.childForFieldName('name')?.text === receiver.text
    },
    builtinTypes: GO_BUILTIN_TYPES,
    notReference: new Set(['parameter_declaration', 'variadic_parameter_declaration', 'var_spec', 'const_spec', 'short_var_declaration', 'labeled_statement']),
  },
  rust: {
    query: `
      (call_expression function: (identifier) @callee)
      (call_expression function: (field_expression value: (_) @receiver field: (field_identifier) @callee))
      (call_expression function: (scoped_identifier) @qualified)
      (call_expression function: (generic_function function: (identifier) @callee))
      (call_expression function: (generic_function function: (scoped_identifier) @qualified))
      (call_expression function: (generic_function function: (field_expression value: (_) @receiver field: (field_identifier) @callee)))
      (type_identifier) @type
      (use_declaration argument: (_) @arg) @stmt`,
    bindings: (matches) => matches.flatMap((m) => {
      const arg = m.captures.find((c) => c.name === 'arg')?.node
      return arg ? rustUse(arg, null, null) : []
    }),
    valueNames: IDENTIFIER,
    self: thisOrSelf,
    builtinTypes: RUST_BUILTIN_TYPES,
    notReference: new Set(['parameter', 'let_declaration', 'mod_item']),
  },
  java: {
    query: `
      (method_invocation object: (_) @receiver name: (identifier) @callee)
      (method_invocation name: (identifier) @callee)
      (object_creation_expression type: (type_identifier) @callee)
      (object_creation_expression type: (generic_type (type_identifier) @callee))
      (type_identifier) @type
      (import_declaration) @stmt`,
    bindings: javaBindings,
    valueNames: IDENTIFIER,
    self: thisOrSelf,
    implicitSelf: true,
    builtinTypes: JAVA_BUILTIN_TYPES,
    notReference: new Set(['formal_parameter', 'variable_declarator', 'catch_formal_parameter']),
  },
  c: {
    query: `
      (call_expression function: (identifier) @callee)
      (call_expression function: (field_expression argument: (_) @receiver field: (field_identifier) @callee))`,
    self: () => false,
  },
  cpp: {
    query: `
      (call_expression function: (identifier) @callee)
      (call_expression function: (field_expression argument: (_) @receiver field: (field_identifier) @callee))
      (call_expression function: (qualified_identifier) @qualified)
      (call_expression function: (template_function name: (identifier) @callee))
      (new_expression type: (type_identifier) @callee)`,
    self: thisOrSelf,
    implicitSelf: true,
  },
  csharp: {
    query: `
      (invocation_expression function: (identifier) @callee)
      (invocation_expression function: (member_access_expression expression: (_) @receiver name: (identifier) @callee))
      (invocation_expression function: (member_access_expression name: (identifier) @callee))
      (object_creation_expression type: (identifier) @callee)`,
    self: (receiver) => receiver.type === 'this' || receiver.type === 'this_expression',
    implicitSelf: true,
  },
  kotlin: {
    query: `
      (call_expression . (identifier) @callee)
      (call_expression . (navigation_expression . (_) @receiver (identifier) @callee .))`,
    self: thisOrSelf,
    implicitSelf: true,
  },
  ruby: {
    query: `
      (call receiver: (_) @receiver method: (identifier) @callee)
      (call method: (identifier) @callee)`,
    self: thisOrSelf,
    implicitSelf: true,
  },
  php: {
    query: `
      (function_call_expression function: (name) @callee)
      (member_call_expression object: (_) @receiver name: (name) @callee)
      (scoped_call_expression scope: (_) @receiver name: (name) @callee)
      (object_creation_expression (name) @callee)`,
    self: (receiver) => receiver.type === 'variable_name' && receiver.text === '$this',
    implicitSelf: true,
  },
}
