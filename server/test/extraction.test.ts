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
        { name: 'foo', kind: 'function', startLine: 4, endLine: 6 },
        { name: 'Bar', kind: 'class', startLine: 8, endLine: 8 },
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
        { name: 'foo', kind: 'function', startLine: 4, endLine: 6 },
        { name: 'Bar', kind: 'class', startLine: 8, endLine: 8 },
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
      { name: 'CounterProps', kind: 'interface', startLine: 6, endLine: 8 },
      { name: 'Counter', kind: 'function', startLine: 10, endLine: 17 },
      { name: 'Mode', kind: 'type', startLine: 21, endLine: 21 },
      { name: 'App', kind: 'function', startLine: 23, endLine: 25 },
      { name: 'Store', kind: 'class', startLine: 27, endLine: 27 },
    ])
  })

  it('keeps the TypeScript grammar for .ts: `<T>value` is a type assertion there, not JSX', async () => {
    const src = ['const n = <number>(1 as unknown)', '', 'export function after() { return n }', ''].join('\n')
    const result = await extractStructure('typescript', src, 'src/cast.ts')
    expect(result.symbols).toEqual([{ name: 'after', kind: 'function', startLine: 3, endLine: 3 }])
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
        { name: 'gen', kind: 'function', startLine: 3, endLine: 3 },
        { name: 'Out', kind: 'type', startLine: 4, endLine: 4 },
      ])
    }
  })

  it('throws for an unsupported language', async () => {
    await expect(extractStructure('rust', 'fn main() {}', 'src/main.rs')).rejects.toThrow()
  })
})
