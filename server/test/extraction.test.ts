import { describe, expect, it } from 'vitest'
import { extractStructure, isSupportedLanguage } from '../src/repositories/extraction.js'
import { detectLanguage } from '../src/repositories/language.js'

describe('isSupportedLanguage', () => {
  it('recognizes the four launch languages, rejects everything else', () => {
    expect(isSupportedLanguage('typescript')).toBe(true)
    expect(isSupportedLanguage('javascript')).toBe(true)
    expect(isSupportedLanguage('python')).toBe(true)
    expect(isSupportedLanguage('go')).toBe(true)
    expect(isSupportedLanguage('rust')).toBe(false)
    expect(isSupportedLanguage(null)).toBe(false)
  })
})

describe('detectLanguage', () => {
  it('labels .ts, .tsx, .mts and .cts as typescript (#449, #451): a typescript filter finds all four', () => {
    expect(detectLanguage('src/a.ts')).toBe('typescript')
    expect(detectLanguage('src/App.tsx')).toBe('typescript')
    expect(detectLanguage('tools/gen.mts')).toBe('typescript')
    expect(detectLanguage('tools/compat.CTS')).toBe('typescript')
    expect(detectLanguage('scripts/build.mjs')).toBe('javascript')
    expect(detectLanguage('scripts/legacy.cjs')).toBe('javascript')
  })
})

describe('extractStructure', () => {
  it('extracts TypeScript imports with their lines and top-level symbols with 1-indexed lines', async () => {
    const src = [
      "import { x } from './a'",
      "import y from '../b'",
      '',
      'export function foo() {',
      '  return 1',
      '}',
      '',
      'class Bar {}',
      '',
    ].join('\n')
    const result = await extractStructure('typescript', src, 'src/a.ts')
    // In document order, each with the line of its specifier (#558).
    expect(result.imports).toEqual([
      { target: './a', line: 1 },
      { target: '../b', line: 2 },
    ])
    expect(result.symbols).toEqual(
      expect.arrayContaining([
        { name: 'foo', kind: 'function', startLine: 4, endLine: 6, exported: true },
        { name: 'Bar', kind: 'class', startLine: 8, endLine: 8, exported: false },
      ]),
    )
  })

  it('extracts JavaScript imports and top-level symbols', async () => {
    const src = [
      "import { x } from './a'",
      "import y from '../b'",
      '',
      'function foo() {',
      '  return 1',
      '}',
      '',
      'class Bar {}',
      '',
    ].join('\n')
    const result = await extractStructure('javascript', src, 'src/a.js')
    expect(result.imports).toEqual([
      { target: './a', line: 1 },
      { target: '../b', line: 2 },
    ])
    expect(result.symbols).toEqual(
      expect.arrayContaining([
        { name: 'foo', kind: 'function', startLine: 4, endLine: 6, exported: false },
        { name: 'Bar', kind: 'class', startLine: 8, endLine: 8, exported: false },
      ]),
    )
  })

  it('extracts Python imports and top-level symbols', async () => {
    const src = [
      'import os',
      'from .utils import helper',
      '',
      'def foo():',
      '    pass',
      '',
      'class Bar:',
      '    pass',
      '',
    ].join('\n')
    const result = await extractStructure('python', src, 'pkg/a.py')
    expect(result.imports).toEqual([
      { target: 'os', line: 1 },
      { target: '.utils', line: 2 },
    ])
    const names = result.symbols.map((s) => s.name).sort()
    expect(names).toEqual(['Bar', 'foo'])
  })

  it('extracts Go imports (including a grouped import block) and top-level symbols', async () => {
    const src = [
      'package main',
      '',
      'import (',
      '\t"fmt"',
      '\t"os"',
      ')',
      '',
      'func Foo() {}',
      '',
      'type Bar struct{}',
      '',
    ].join('\n')
    const result = await extractStructure('go', src, 'main.go')
    expect(result.imports).toEqual([
      { target: 'fmt', line: 4 },
      { target: 'os', line: 5 },
    ])
    const names = result.symbols.map((s) => s.name).sort()
    expect(names).toEqual(['Bar', 'Foo'])
  })

  // #449: JSX is not TypeScript syntax: the TypeScript grammar reads `<div>`
  // as a type assertion and the parse breaks. A component file must parse
  // with the TSX grammar, chosen from its path.
  it('parses a .tsx component (JSX, `<T,>() =>` generics, default export) with the TSX grammar', async () => {
    const src = [
      "import { useState } from 'react'",
      "import { Button } from './Button.js'",
      '',
      'export const identity = <T,>(value: T): T => value',
      '',
      'export interface CounterProps {',
      '  start: number',
      '}',
      '',
      'export function Counter({ start }: CounterProps) {',
      '  const [n, setN] = useState(start)',
      '  return (',
      '    <div className="counter">',
      '      <Button onClick={() => setN(n + 1)}>{n}</Button>',
      '    </div>',
      '  )',
      '}',
      '',
      "import { cn } from '@/lib/utils'",
      '',
      'type Mode = "a" | "b"',
      '',
      'export default function App({ mode }: { mode: Mode }) {',
      '  return <section className={cn(mode)}><Counter start={identity(1)} /></section>',
      '}',
      '',
      'class Store {}',
      '',
    ].join('\n')
    const result = await extractStructure('typescript', src, 'client/src/App.tsx')
    expect(result.imports).toEqual([
      { target: 'react', line: 1 },
      { target: './Button.js', line: 2 },
      { target: '@/lib/utils', line: 19 },
    ])
    expect(result.symbols).toEqual([
      { name: 'identity', kind: 'function', startLine: 4, endLine: 4, exported: true },
      { name: 'CounterProps', kind: 'interface', startLine: 6, endLine: 8, exported: true },
      { name: 'Counter', kind: 'function', startLine: 10, endLine: 17, exported: true },
      { name: 'Mode', kind: 'type', startLine: 21, endLine: 21, exported: false },
      { name: 'App', kind: 'function', startLine: 23, endLine: 25, exported: true },
      { name: 'Store', kind: 'class', startLine: 27, endLine: 27, exported: false },
    ])
  })

  it('keeps the TypeScript grammar for .ts: `<T>value` is a type assertion there, not JSX', async () => {
    const src = ['const n = <number>(1 as unknown)', '', 'export function after() { return n }', ''].join('\n')
    const result = await extractStructure('typescript', src, 'src/cast.ts')
    expect(result.symbols).toEqual([{ name: 'after', kind: 'function', startLine: 3, endLine: 3, exported: true }])
  })

  it('extracts .mts and .cts files with the TypeScript grammar (#451)', async () => {
    const src = [
      "import { load } from './load.mjs'",
      '',
      'export function gen() { return load() }',
      'export type Out = string',
      '',
    ].join('\n')
    for (const path of ['tools/gen.mts', 'tools/gen.cts']) {
      const language = detectLanguage(path)
      expect(language).toBe('typescript')
      const result = await extractStructure(language!, src, path)
      expect(result.imports).toEqual([{ target: './load.mjs', line: 1 }])
      expect(result.symbols).toEqual([
        { name: 'gen', kind: 'function', startLine: 3, endLine: 3, exported: true },
        { name: 'Out', kind: 'type', startLine: 4, endLine: 4, exported: true },
      ])
    }
  })

  // #466: a module's edges are also its re-exports, its lazy `import()`s and
  // CommonJS `require`s, as long as the specifier is a literal.
  it('captures re-exports, dynamic import() and require() with a literal specifier, in TS, TSX and JS (#466)', async () => {
    const lines = [
      "import { a } from './a'",
      "export { b } from './b'",
      "export * from './c'",
      "export * as d from './d'",
      "const e = await import('./e')",
      'const f = await import(`./f`)',
      "const g = require('./g')",
      "const lazy = () => import('./h?raw')",
      'const dynamic = await import(name)',
      'const computed = await import(`./locale/${lang}`)',
      'const req = require(name)',
      "const notRequire = load('./not-an-import')",
      "const two = require('./i', 'extra')",
      '',
    ]
    const expected = [
      { target: './a', line: 1 },
      { target: './b', line: 2 },
      { target: './c', line: 3 },
      { target: './d', line: 4 },
      { target: './e', line: 5 },
      { target: './f', line: 6 },
      { target: './g', line: 7 },
      { target: './h?raw', line: 8 },
    ]
    for (const [language, path] of [
      ['typescript', 'src/mod.ts'],
      ['typescript', 'src/mod.tsx'],
      ['javascript', 'src/mod.js'],
    ] as const) {
      const result = await extractStructure(language, lines.join('\n'), path)
      expect(result.imports, path).toEqual(expected)
    }

    // TypeScript only: `export type ... from` and `import x = require()`.
    const ts = ["export type { T } from './types'", "import fs = require('./fs-shim')", ''].join('\n')
    expect((await extractStructure('typescript', ts, 'src/types.ts')).imports).toEqual([
      { target: './types', line: 1 },
      { target: './fs-shim', line: 2 },
    ])
  })

  it('throws for an unsupported language', async () => {
    await expect(extractStructure('rust', 'fn main() {}', 'src/main.rs')).rejects.toThrow()
  })
})
