import { describe, expect, it } from 'vitest'
import { extractStructure, isSupportedLanguage } from '../src/repositories/extraction.js'

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

describe('extractStructure', () => {
  it('extracts TypeScript imports and top-level symbols with 1-indexed lines', async () => {
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
    const result = await extractStructure('typescript', src)
    expect(result.imports.sort()).toEqual(['../b', './a'])
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
    const result = await extractStructure('python', src)
    expect(result.imports.sort()).toEqual(['.utils', 'os'])
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
    const result = await extractStructure('go', src)
    expect(result.imports.sort()).toEqual(['fmt', 'os'])
    const names = result.symbols.map((s) => s.name).sort()
    expect(names).toEqual(['Bar', 'Foo'])
  })

  it('throws for an unsupported language', async () => {
    await expect(extractStructure('rust', 'fn main() {}')).rejects.toThrow()
  })
})
