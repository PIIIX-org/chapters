// #469: symbol-level code edges at index time (ADR-004 §2.8). Extraction
// stores, per repository file, its call, reference, import and test edges
// in `code_edges`: the enclosing symbol, the target name, the line, column
// and one line of context, and the target symbol block when one is found:
// `resolved` through the file's own scope, its imports or its package,
// `textual` when matched by name only (a unique definition in the
// repository), no target when the name is ambiguous or undefined. One
// fixture per language with known sites; the incremental cases compare an
// index built by a sequence of pushes with one built in a single push.
import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser } from './helpers.js'

type Files = Record<string, string>

interface Edge {
  path: string
  kind: string
  line: number
  col: number
  name: string
  qualified: string | null
  confidence: string
  /** The target symbol's file and inner path (`Class.method`), when the edge has one. */
  target: string | null
  /** The enclosing symbol's inner path, null at module level. */
  source: string | null
  context: string
}

async function makeRepo(name: string): Promise<string> {
  const owner = await createActiveUser()
  const [repo] = await db.insert(repositories).values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
  return repo!.id
}

/** Pushes `files` as the repository's whole content (paths not in it are deleted) and waits for extraction. */
async function push(repositoryId: string, files: Files): Promise<void> {
  await syncRepositoryFiles(
    repositoryId,
    Object.entries(files).map(([path, content]) => ({ path, content })),
    Object.keys(files),
  )
  await flushExtraction()
}

async function repoWith(name: string, files: Files): Promise<string> {
  const id = await makeRepo(name)
  await push(id, files)
  return id
}

/** Every code edge of a repository, by paths and inner paths (no ids), in a stable order. None when the table does not exist. */
async function edgesOf(repositoryId: string): Promise<Edge[]> {
  const [{ exists }] = (await db.execute(sql`SELECT to_regclass('code_edges') IS NOT NULL AS exists`)) as unknown as [{ exists: boolean }]
  if (!exists) return []
  return (await db.execute(sql`
    SELECT sf.path, e.kind, e.line, e.col, e.target_name AS name, e.target_qualified AS qualified, e.confidence,
      CASE WHEN tb.block_id IS NULL THEN NULL ELSE tf.path || '#' || tb.inner_path END AS target,
      sb.inner_path AS source, e.context
    FROM code_edges e
    JOIN repository_files sf ON sf.id = e.source_file_id
    LEFT JOIN repository_files tf ON tf.id = e.target_file_id
    LEFT JOIN blocks tb ON tb.owner_type = 'code' AND tb.owner_id = e.target_file_id AND tb.block_id = e.target_block_id
    LEFT JOIN blocks sb ON sb.owner_type = 'code' AND sb.owner_id = e.source_file_id AND sb.block_id = e.source_block_id
    WHERE e.repository_id = ${repositoryId}
    ORDER BY sf.path COLLATE "C", e.line, e.col, e.kind, e.target_name COLLATE "C"`)) as unknown as Edge[]
}

/** The one edge of `kind` named `name` at `path:line`. */
function edgeAt(edges: Edge[], path: string, line: number, kind: string, name: string): Edge | undefined {
  const found = edges.filter((e) => e.path === path && e.line === line && e.kind === kind && e.name === name)
  expect(found.length, `${kind} ${name} at ${path}:${line}`).toBeLessThanOrEqual(1)
  return found[0]
}

/** What an edge resolved to: confidence, target, enclosing symbol. */
function shape(e: Edge | undefined) {
  return e && { confidence: e.confidence, target: e.target, source: e.source }
}

/** The definitions a name has in a repository: symbol blocks whose bare name it is, one per file and inner path. */
async function candidates(repositoryId: string, name: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT f.path || '#' || b.inner_path AS target
    FROM blocks b JOIN repository_files f ON f.id = b.owner_id
    WHERE b.owner_type = 'code' AND b.container_id = ${repositoryId} AND b.kind = 'symbol'
      AND (b.inner_path = ${name} OR b.symbol_parent IS NOT NULL AND b.inner_path = b.symbol_parent || '.' || ${name})
    ORDER BY 1`)) as unknown as Array<{ target: string }>
  return rows.map((r) => r.target)
}

const TS: Files = {
  'src/store.ts': [
    'export class Store {',
    '  save(x: string): void {',
    '    this.flush()',
    '  }',
    '  flush(): void {}',
    '}',
    '',
    'export function open(): Store {',
    '  return new Store()',
    '}',
    '',
    'export function parse(s: string): string {',
    '  return s',
    '}',
    '',
  ].join('\n'),
  'src/util.ts': ['export function parse(s: string): string {', '  return s.trim()', '}', ''].join('\n'),
  'src/app.ts': [
    "import { open as openStore, Store } from './store'",
    "import { missing } from './nowhere'",
    '',
    'export function run(): void {',
    '  const s: Store = openStore()',
    "  s.save('x')",
    '  helper()',
    "  parse('y')",
    '  missing()',
    '}',
    '',
    'function helper(): void {}',
    '',
  ].join('\n'),
  'src/app.test.ts': ["import { run } from './app'", '', 'run()', ''].join('\n'),
}

describe('code edges (#469)', () => {
  it('TypeScript: local, imported, unique, ambiguous and undefined names; symbol-level imports; test edges', async () => {
    const repo = await repoWith('edges-ts', TS)
    const edges = await edgesOf(repo)

    // Names this file imports, resolved through its import rows.
    expect(shape(edgeAt(edges, 'src/app.ts', 1, 'import', 'open'))).toEqual({ confidence: 'resolved', target: 'src/store.ts#open', source: null })
    expect(shape(edgeAt(edges, 'src/app.ts', 1, 'import', 'Store'))).toEqual({ confidence: 'resolved', target: 'src/store.ts#Store', source: null })
    // An import whose module is not in the repository: textual, no target.
    expect(shape(edgeAt(edges, 'src/app.ts', 2, 'import', 'missing'))).toEqual({ confidence: 'textual', target: null, source: null })

    // A call through an import alias names the imported symbol, and keeps the written line as context.
    const call = edgeAt(edges, 'src/app.ts', 5, 'call', 'open')
    expect(shape(call)).toEqual({ confidence: 'resolved', target: 'src/store.ts#open', source: 'run' })
    expect(call).toMatchObject({ col: 20, context: 'const s: Store = openStore()' })
    expect(shape(edgeAt(edges, 'src/app.ts', 5, 'reference', 'Store'))).toEqual({ confidence: 'resolved', target: 'src/store.ts#Store', source: 'run' })
    // A method on a receiver of unknown type: the one `save` in the repository, matched by name only.
    expect(shape(edgeAt(edges, 'src/app.ts', 6, 'call', 'save'))).toEqual({ confidence: 'textual', target: 'src/store.ts#Store.save', source: 'run' })
    // A local definition.
    expect(shape(edgeAt(edges, 'src/app.ts', 7, 'call', 'helper'))).toEqual({ confidence: 'resolved', target: 'src/app.ts#helper', source: 'run' })
    // Ambiguous: two `parse` definitions, neither imported here. Textual, no target, candidates countable.
    expect(shape(edgeAt(edges, 'src/app.ts', 8, 'call', 'parse'))).toEqual({ confidence: 'textual', target: null, source: 'run' })
    expect(await candidates(repo, 'parse')).toEqual(['src/store.ts#parse', 'src/util.ts#parse'])
    // Defined nowhere.
    expect(shape(edgeAt(edges, 'src/app.ts', 9, 'call', 'missing'))).toEqual({ confidence: 'textual', target: null, source: 'run' })

    // `this.method()` is the enclosing class's method; `new Store()` and a return type name the local class.
    const own = edgeAt(edges, 'src/store.ts', 3, 'call', 'flush')
    expect(shape(own)).toEqual({ confidence: 'resolved', target: 'src/store.ts#Store.flush', source: 'Store.save' })
    expect(own?.qualified).toBe('Store.flush')
    expect(shape(edgeAt(edges, 'src/store.ts', 9, 'call', 'Store'))).toEqual({ confidence: 'resolved', target: 'src/store.ts#Store', source: 'open' })
    expect(shape(edgeAt(edges, 'src/store.ts', 8, 'reference', 'Store'))).toEqual({ confidence: 'resolved', target: 'src/store.ts#Store', source: 'open' })

    // Test edges: only from a test file, to what it uses, not to its own definitions.
    expect(shape(edgeAt(edges, 'src/app.test.ts', 3, 'test', 'run'))).toEqual({ confidence: 'resolved', target: 'src/app.ts#run', source: null })
    expect(shape(edgeAt(edges, 'src/app.test.ts', 3, 'call', 'run'))).toEqual({ confidence: 'resolved', target: 'src/app.ts#run', source: null })
    expect(edges.filter((e) => e.kind === 'test').map((e) => e.path)).toEqual(['src/app.test.ts'])
    // Declarations are not references.
    expect(edgeAt(edges, 'src/store.ts', 1, 'reference', 'Store')).toBeUndefined()
  })

  it('TSX: a JSX element is a call of its component; an HTML tag is not', async () => {
    const repo = await repoWith('edges-tsx', {
      'src/button.tsx': ['export function Button(props: { label: string }) {', '  return <div>{props.label}</div>', '}', ''].join('\n'),
      'src/view.tsx': [
        "import { Button } from './button'",
        '',
        'export function View() {',
        '  return <Button label={title()} />',
        '}',
        '',
        'function title(): string {',
        "  return 'x'",
        '}',
        '',
      ].join('\n'),
    })
    const edges = await edgesOf(repo)
    expect(shape(edgeAt(edges, 'src/view.tsx', 4, 'call', 'Button'))).toEqual({ confidence: 'resolved', target: 'src/button.tsx#Button', source: 'View' })
    expect(shape(edgeAt(edges, 'src/view.tsx', 4, 'call', 'title'))).toEqual({ confidence: 'resolved', target: 'src/view.tsx#title', source: 'View' })
    expect(edges.some((e) => e.name === 'div')).toBe(false)
  })

  it('JavaScript: a name destructured from require() resolves across files', async () => {
    const repo = await repoWith('edges-js', {
      'lib/b.js': ['function b() {', '  return 1', '}', 'module.exports = { b }', ''].join('\n'),
      'lib/a.js': ["const { b } = require('./b')", '', 'function a() {', '  return b()', '}', ''].join('\n'),
    })
    const edges = await edgesOf(repo)
    expect(shape(edgeAt(edges, 'lib/a.js', 1, 'import', 'b'))).toEqual({ confidence: 'resolved', target: 'lib/b.js#b', source: null })
    expect(shape(edgeAt(edges, 'lib/a.js', 4, 'call', 'b'))).toEqual({ confidence: 'resolved', target: 'lib/b.js#b', source: 'a' })
    expect(shape(edgeAt(edges, 'lib/b.js', 4, 'reference', 'b'))).toEqual({ confidence: 'resolved', target: 'lib/b.js#b', source: null })
  })

  it('Python: self methods resolve; names from an unresolved import are textual; test_*.py has test edges', async () => {
    const repo = await repoWith('edges-py', {
      'pkg/models.py': ['class Repo:', '    def get(self):', '        return self.load()', '', '    def load(self):', '        return 1', ''].join('\n'),
      'pkg/service.py': ['from .models import Repo', '', '', 'def serve():', '    r = Repo()', '    return r.get()', ''].join('\n'),
      'tests/test_service.py': ['from pkg.service import serve', '', '', 'def test_serve():', '    assert serve() == 1', ''].join('\n'),
    })
    const edges = await edgesOf(repo)
    expect(shape(edgeAt(edges, 'pkg/models.py', 3, 'call', 'load'))).toEqual({ confidence: 'resolved', target: 'pkg/models.py#Repo.load', source: 'Repo.get' })
    // Python module specifiers do not resolve to files (import-resolution.ts): the unique definition, by name.
    expect(shape(edgeAt(edges, 'pkg/service.py', 1, 'import', 'Repo'))).toEqual({ confidence: 'textual', target: 'pkg/models.py#Repo', source: null })
    expect(shape(edgeAt(edges, 'pkg/service.py', 5, 'call', 'Repo'))).toEqual({ confidence: 'textual', target: 'pkg/models.py#Repo', source: 'serve' })
    expect(shape(edgeAt(edges, 'pkg/service.py', 6, 'call', 'get'))).toEqual({ confidence: 'textual', target: 'pkg/models.py#Repo.get', source: 'serve' })
    expect(shape(edgeAt(edges, 'tests/test_service.py', 5, 'test', 'serve'))).toEqual({ confidence: 'textual', target: 'pkg/service.py#serve', source: null })
    expect(edges.filter((e) => e.kind === 'test').map((e) => e.name)).toEqual(['serve'])
  })

  it('Go: the package is the scope across files; *_test.go has test edges', async () => {
    const repo = await repoWith('edges-go', {
      'store/store.go': ['package store', '', 'type Store struct{}', '', 'func (s *Store) Save() {', '\ts.flush()', '}', '', 'func New() *Store {', '\treturn &Store{}', '}', ''].join('\n'),
      'store/flush.go': ['package store', '', 'func (s *Store) flush() {}', '', 'func helper() int { return 1 }', ''].join('\n'),
      'store/use.go': ['package store', '', 'func run() int {', '\tNew().Save()', '\treturn helper()', '}', ''].join('\n'),
      'cmd/main.go': ['package main', '', 'import "example.com/m/store"', '', 'func main() {', '\tstore.New()', '}', ''].join('\n'),
      'store/store_test.go': ['package store', '', 'import "testing"', '', 'func TestSave(t *testing.T) {', '\tNew().Save()', '}', ''].join('\n'),
    })
    const edges = await edgesOf(repo)
    // The receiver's method in another file of the package.
    expect(shape(edgeAt(edges, 'store/store.go', 6, 'call', 'flush'))).toEqual({ confidence: 'resolved', target: 'store/flush.go#Store.flush', source: 'Store.Save' })
    expect(shape(edgeAt(edges, 'store/store.go', 10, 'reference', 'Store'))).toEqual({ confidence: 'resolved', target: 'store/store.go#Store', source: 'New' })
    expect(shape(edgeAt(edges, 'store/use.go', 4, 'call', 'New'))).toEqual({ confidence: 'resolved', target: 'store/store.go#New', source: 'run' })
    expect(shape(edgeAt(edges, 'store/use.go', 5, 'call', 'helper'))).toEqual({ confidence: 'resolved', target: 'store/flush.go#helper', source: 'run' })
    // A method of an unknown receiver: by name only.
    expect(shape(edgeAt(edges, 'store/use.go', 4, 'call', 'Save'))).toEqual({ confidence: 'textual', target: 'store/store.go#Store.Save', source: 'run' })
    // Another package, through a module path that does not resolve to a file: by name.
    expect(shape(edgeAt(edges, 'cmd/main.go', 6, 'call', 'New'))).toEqual({ confidence: 'textual', target: 'store/store.go#New', source: 'main' })
    const tests = edges.filter((e) => e.kind === 'test')
    expect(tests.map((e) => [e.name, e.confidence, e.target])).toEqual([
      ['New', 'resolved', 'store/store.go#New'],
      ['Save', 'textual', 'store/store.go#Store.Save'],
    ])
    expect(tests.every((e) => e.path === 'store/store_test.go')).toBe(true)
  })

  it('Rust: a `use`d type and its associated function resolve across files', async () => {
    const repo = await repoWith('edges-rust', {
      'src/store.rs': [
        'pub struct Store;',
        '',
        'impl Store {',
        '    pub fn new() -> Store {',
        '        Store',
        '    }',
        '',
        '    pub fn save(&self) {',
        '        self.flush()',
        '    }',
        '',
        '    fn flush(&self) {}',
        '}',
        '',
      ].join('\n'),
      'src/main.rs': ['mod store;', 'use crate::store::Store;', '', 'fn main() {', '    let s = Store::new();', '    s.save();', '    run()', '}', '', 'fn run() {}', ''].join('\n'),
    })
    const edges = await edgesOf(repo)
    expect(shape(edgeAt(edges, 'src/main.rs', 2, 'import', 'Store'))).toEqual({ confidence: 'resolved', target: 'src/store.rs#Store', source: null })
    const assoc = edgeAt(edges, 'src/main.rs', 5, 'call', 'new')
    expect(shape(assoc)).toEqual({ confidence: 'resolved', target: 'src/store.rs#Store.new', source: 'main' })
    expect(assoc?.qualified).toBe('Store.new')
    expect(shape(edgeAt(edges, 'src/main.rs', 6, 'call', 'save'))).toEqual({ confidence: 'textual', target: 'src/store.rs#Store.save', source: 'main' })
    expect(shape(edgeAt(edges, 'src/main.rs', 7, 'call', 'run'))).toEqual({ confidence: 'resolved', target: 'src/main.rs#run', source: 'main' })
    expect(shape(edgeAt(edges, 'src/store.rs', 9, 'call', 'flush'))).toEqual({ confidence: 'resolved', target: 'src/store.rs#Store.flush', source: 'Store.save' })
    expect(shape(edgeAt(edges, 'src/store.rs', 4, 'reference', 'Store'))).toEqual({ confidence: 'resolved', target: 'src/store.rs#Store', source: 'Store.new' })
  })

  it('Java: implicit this, an imported class and its static method; src/test/** has test edges', async () => {
    const repo = await repoWith('edges-java', {
      'src/main/java/com/acme/Store.java': [
        'package com.acme;',
        '',
        'public class Store {',
        '    public void save() {',
        '        flush();',
        '    }',
        '',
        '    void flush() {}',
        '',
        '    public static Store open() {',
        '        return new Store();',
        '    }',
        '}',
        '',
      ].join('\n'),
      'src/main/java/com/acme/app/App.java': [
        'package com.acme.app;',
        '',
        'import com.acme.Store;',
        '',
        'public class App {',
        '    void run() {',
        '        Store s = Store.open();',
        '        s.save();',
        '    }',
        '}',
        '',
      ].join('\n'),
      'src/test/java/com/acme/StoreTest.java': ['package com.acme;', '', 'class StoreTest {', '    void saves() {', '        new Store().save();', '    }', '}', ''].join('\n'),
    })
    const edges = await edgesOf(repo)
    const main = 'src/main/java/com/acme/Store.java'
    expect(shape(edgeAt(edges, main, 5, 'call', 'flush'))).toEqual({ confidence: 'resolved', target: `${main}#Store.flush`, source: 'Store.save' })
    expect(shape(edgeAt(edges, main, 11, 'call', 'Store'))).toEqual({ confidence: 'resolved', target: `${main}#Store`, source: 'Store.open' })
    const app = 'src/main/java/com/acme/app/App.java'
    expect(shape(edgeAt(edges, app, 3, 'import', 'Store'))).toEqual({ confidence: 'resolved', target: `${main}#Store`, source: null })
    expect(shape(edgeAt(edges, app, 7, 'call', 'open'))).toEqual({ confidence: 'resolved', target: `${main}#Store.open`, source: 'App.run' })
    expect(shape(edgeAt(edges, app, 7, 'reference', 'Store'))).toEqual({ confidence: 'resolved', target: `${main}#Store`, source: 'App.run' })
    expect(shape(edgeAt(edges, app, 8, 'call', 'save'))).toEqual({ confidence: 'textual', target: `${main}#Store.save`, source: 'App.run' })
    const tests = edges.filter((e) => e.kind === 'test')
    expect(tests.map((e) => [e.path, e.name, e.target])).toEqual([
      ['src/test/java/com/acme/StoreTest.java', 'Store', `${main}#Store`],
      ['src/test/java/com/acme/StoreTest.java', 'save', `${main}#Store.save`],
    ])
  })

  it('C (calls only): a function declared in an included header resolves through the include', async () => {
    const repo = await repoWith('edges-c', {
      'src/util.h': 'int helper(int x);\n',
      'src/util.c': ['#include "util.h"', '', 'int helper(int x) {', '    return x;', '}', ''].join('\n'),
      'src/main.c': ['#include "util.h"', '', 'static int other(void) {', '    return 0;', '}', '', 'int main(void) {', '    return helper(1) + other() + printf("x");', '}', ''].join('\n'),
    })
    const edges = await edgesOf(repo)
    expect(shape(edgeAt(edges, 'src/main.c', 8, 'call', 'helper'))).toEqual({ confidence: 'resolved', target: 'src/util.h#helper', source: 'main' })
    expect(shape(edgeAt(edges, 'src/main.c', 8, 'call', 'other'))).toEqual({ confidence: 'resolved', target: 'src/main.c#other', source: 'main' })
    expect(shape(edgeAt(edges, 'src/main.c', 8, 'call', 'printf'))).toEqual({ confidence: 'textual', target: null, source: 'main' })
    expect(edges.filter((e) => e.kind === 'reference')).toEqual([])
  })

  it('C++, C#, Kotlin, Ruby and PHP (calls only): a call of a method of the same class resolves', async () => {
    const repo = await repoWith('edges-calls-only', {
      'cpp/store.cpp': ['class Store {', ' public:', '  void save() { flush(); }', '  void flush() {}', '};', ''].join('\n'),
      'cs/Store.cs': ['class Store {', '    void Save() { this.Flush(); }', '    void Flush() {}', '}', ''].join('\n'),
      'kt/Store.kt': ['class Store {', '    fun save() { flush() }', '    fun flush() {}', '}', ''].join('\n'),
      'rb/store.rb': ['class Store', '  def save', '    flush(1)', '  end', '', '  def flush(x)', '  end', 'end', ''].join('\n'),
      'php/Store.php': ['<?php', 'class Store {', '    function save() { $this->flush(); }', '    function flush() {}', '}', ''].join('\n'),
    })
    const edges = await edgesOf(repo)
    const calls = edges.filter((e) => e.kind === 'call').map((e) => [e.path, e.line, e.confidence, e.target, e.source])
    expect(calls).toEqual([
      ['cpp/store.cpp', 3, 'resolved', 'cpp/store.cpp#Store.flush', 'Store.save'],
      ['cs/Store.cs', 2, 'resolved', 'cs/Store.cs#Store.Flush', 'Store.Save'],
      ['kt/Store.kt', 2, 'resolved', 'kt/Store.kt#Store.flush', 'Store.save'],
      ['php/Store.php', 3, 'resolved', 'php/Store.php#Store.flush', 'Store.save'],
      ['rb/store.rb', 3, 'resolved', 'rb/store.rb#Store.flush', 'Store.save'],
    ])
    expect(edges.filter((e) => e.kind === 'reference')).toEqual([])
  })
})

// The table is a function of the files: any sequence of pushes ends with the
// rows one push of the final files gives (the #1010/#1008 order tests).
const FINAL: Files = {
  ...TS,
  'store/store.go': ['package store', '', 'type Store struct{}', '', 'func (s *Store) Save() {', '\ts.flush()', '}', '', 'func New() *Store {', '\treturn &Store{}', '}', ''].join('\n'),
  'store/flush.go': ['package store', '', 'func (s *Store) flush() {}', '', 'func helper() int { return 1 }', ''].join('\n'),
  'store/use.go': ['package store', '', 'func run() int {', '\tNew().Save()', '\treturn helper()', '}', ''].join('\n'),
}

describe('code edges after a sequence of pushes (#469)', () => {
  it('equal the edges of one push of the final files', async () => {
    const expected = await edgesOf(await repoWith('edges-order-a', FINAL))
    expect(expected.length).toBeGreaterThan(30)

    const repo = await makeRepo('edges-order-b')
    // Every path exists from the start (an import row resolves only to a file that exists, #1008), with other content:
    // `parse` unique in util.ts and no `flush` in store.ts; util.ts also defines `save` (a second one) and `helper`.
    const v0: Files = {
      ...FINAL,
      'src/store.ts': 'export class Store {\n  save(x: string): void {}\n}\n\nexport function open(): Store {\n  return new Store()\n}\n',
      'src/util.ts': 'export function parse(s: string): string {\n  return s\n}\n\nexport function save(): void {}\n\nexport function helper(): void {}\n',
      'store/flush.go': 'package store\n',
      'src/extra.ts': 'export function open(): void {}\nexport function run(): void {}\n',
    }
    await push(repo, v0)
    // One file at a time, in reverse, each extracted before the next.
    for (const path of ['store/flush.go', 'src/store.ts']) await push(repo, { ...v0, [path]: FINAL[path]! })
    await push(repo, { ...v0, 'store/flush.go': FINAL['store/flush.go']!, 'src/store.ts': FINAL['src/store.ts']! })
    // util.ts loses `save` and `helper`; extra.ts (a second `open` and `run`) is deleted.
    await push(repo, FINAL)
    expect(await edgesOf(repo)).toEqual(expected)

    // A definition renamed away and back.
    await push(repo, { ...FINAL, 'src/store.ts': FINAL['src/store.ts']!.replace('flush', 'flushAll') })
    expect(await edgesOf(repo)).not.toEqual(expected)
    await push(repo, FINAL)
    expect(await edgesOf(repo)).toEqual(expected)
  })

  // #1008: an import row resolves only to a file present when its importer is extracted; a target pushed later
  // leaves it unresolved, so the edges through it fall back to the name. #1023 re-resolves the import rows.
  it.fails('equal them when an importer is pushed before its target (#1008)', async () => {
    const expected = await edgesOf(await repoWith('edges-late-a', TS))
    const repo = await makeRepo('edges-late-b')
    const { 'src/store.ts': store, ...rest } = TS
    await push(repo, rest)
    await push(repo, { ...rest, 'src/store.ts': store! })
    expect(expected.length).toBeGreaterThan(0)
    expect(await edgesOf(repo)).toEqual(expected)
  })
})
