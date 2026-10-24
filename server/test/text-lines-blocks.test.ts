// ADR-004 §2.2 (#413, #418): the line contract and block ids, as pure
// functions (text/lines.ts, text/blocks.ts) and the code chunker built on
// them (repositories/code-blocks.ts).
import { describe, expect, it } from 'vitest'
import { codeBlocks, SMALL_FILE_MAX_LINES } from '../src/repositories/code-blocks.js'
import type { ExtractedSymbol } from '../src/repositories/extraction.js'
import { blockId, headings, siblingIndexes } from '../src/text/blocks.js'
import { lineStarts, location, sliceLines, totalLines } from '../src/text/lines.js'

/** Lines 1..total joined back, plus the final `\n` when the text has one: the text itself. */
const roundTrip = (text: string) => sliceLines(text, 1, totalLines(text)) + (text.endsWith('\n') ? '\n' : '')

describe('lines (#418)', () => {
  it('total_lines: empty is 0, a final line without \\n counts, a trailing \\n adds none', () => {
    expect([totalLines(''), totalLines('a'), totalLines('a\n'), totalLines('a\nb'), totalLines('\n'), totalLines('\n\n')]).toEqual([0, 1, 1, 2, 1, 2])
    expect(totalLines('a\r\nb\r\n')).toBe(2)
  })

  it('splits on \\n only: \\r stays on its line, blank lines are lines', () => {
    const text = 'one\r\n\r\nthree\r\n'
    expect(lineStarts(text)).toEqual([0, 5, 7])
    expect([1, 2, 3].map((n) => sliceLines(text, n, n))).toEqual(['one\r', '\r', 'three\r'])
    expect(sliceLines(text, 1, 2)).toBe('one\r\n\r')
  })

  it('every text round-trips through its lines (CRLF, blank lines, no final newline, lone \\r)', () => {
    for (const text of ['', '\n', 'a', 'a\n', 'a\n\n\nb', 'a\r\n\r\nb\r\n', '\r', 'x\ry\n', '\n\n', 'tail\n\n']) {
      expect(roundTrip(text)).toBe(text)
    }
  })

  it('a slice is a substring of the text: out-of-range ends clamp, an empty range is empty', () => {
    const text = 'a\nb\nc'
    expect(sliceLines(text, 2, 99)).toBe('b\nc')
    expect(sliceLines(text, 3, 2)).toBe('')
    expect(sliceLines(text, 4, 5)).toBe('')
    expect(sliceLines(text, 0, 1)).toBe('')
  })

  it('location: path#La-Lb, path#La for one line', () => {
    expect(location('src/a.ts', 3, 9)).toBe('src/a.ts#L3-L9')
    expect(location('src/a.ts', 4, 4)).toBe('src/a.ts#L4')
  })
})

describe('block ids (#413)', () => {
  const OWNER = '7f6c1e2a-0000-4000-8000-000000000001'

  it("'b_' + 12 base32 characters of sha256(owner ␟ kind ␟ inner_path ␟ sibling_index)", () => {
    const id = blockId(OWNER, 'symbol', 'Store.save', 0)
    expect(id).toMatch(/^b_[a-z2-7]{12}$/)
    expect(blockId(OWNER, 'symbol', 'Store.save', 0)).toBe(id)
    // Each part of the formula changes it.
    expect(new Set([
      id,
      blockId(OWNER.replace(/1$/, '2'), 'symbol', 'Store.save', 0),
      blockId(OWNER, 'skeleton', 'Store.save', 0),
      blockId(OWNER, 'symbol', 'Store.load', 0),
      blockId(OWNER, 'symbol', 'Store.save', 1),
    ]).size).toBe(5)
  })

  it('duplicate headings and overloads get their sibling_index in document order', () => {
    expect(
      siblingIndexes([
        { kind: 'section', innerPath: 'Notes' },
        { kind: 'section', innerPath: 'Plan' },
        { kind: 'section', innerPath: 'Notes' },
        { kind: 'symbol', innerPath: 'Notes' },
        { kind: 'section', innerPath: 'Notes' },
      ]),
    ).toEqual([0, 0, 1, 0, 2])
  })

  it('the heading parser skips fenced code (moved from edit-ops, which uses it)', () => {
    expect(headings('# A\n```\n# not a heading\n```\n## B ##\r\n').map((h) => [h.level, h.title])).toEqual([
      [1, 'A'],
      [2, 'B'],
    ])
  })
})

const sym = (name: string, startLine: number, endLine: number, extra: Partial<ExtractedSymbol> = {}): ExtractedSymbol => ({
  name,
  kind: 'function',
  startLine,
  endLine,
  exported: true,
  ...extra,
})

describe('code blocks (#452a)', () => {
  const FILE = '2d3f0b1c-0000-4000-8000-000000000002'

  it('a block id survives a line shift; its lines and the text it embeds follow the symbol', () => {
    const content = 'export function f() {\n  return 1\n}\n'
    const shifted = `// header\n\n${content}`
    const [, before] = codeBlocks(FILE, 'src/f.ts', content, [sym('f', 1, 3)])
    const [, after] = codeBlocks(FILE, 'src/f.ts', shifted, [sym('f', 3, 5)])
    expect(after!.blockId).toBe(before!.blockId)
    expect([after!.startLine, after!.endLine]).toEqual([3, 5])
    expect(after!.contentHash).toBe(before!.contentHash)
    expect(after!.embedText).toBe(before!.embedText)
    expect(after!.embedText).toBe('function f in src/f.ts\nexport function f() {\n  return 1\n}')
  })

  it('overloads and methods: inner_path is Class.method, equal ones get the next sibling_index', () => {
    const content = ['export class Store {', '  save(a: string)', '  save(a: number)', '  save(a: any) {}', '}', ''].join('\n')
    const blocks = codeBlocks(FILE, 'src/store.ts', content, [
      sym('Store', 1, 5, { kind: 'class' }),
      sym('save', 2, 2, { kind: 'method', parent: 'Store', exported: false }),
      sym('save', 3, 3, { kind: 'method', parent: 'Store', exported: false }),
      sym('save', 4, 4, { kind: 'method', parent: 'Store', exported: false }),
    ])
    expect(blocks.map((b) => [b.kind, b.innerPath, b.symbolKind, b.symbolParent])).toEqual([
      ['file', '', null, null],
      ['symbol', 'Store', 'class', null],
      ['symbol', 'Store.save', 'method', 'Store'],
      ['symbol', 'Store.save', 'method', 'Store'],
      ['symbol', 'Store.save', 'method', 'Store'],
    ])
    const saves = blocks.slice(2).map((b) => b.blockId)
    expect(new Set(saves).size).toBe(3)
    expect(saves).toEqual([0, 1, 2].map((i) => blockId(FILE, 'symbol', 'Store.save', i)))
  })

  it('a small file is one file block; a larger one with symbols gets a file and a class skeleton instead', () => {
    const small = codeBlocks(FILE, 'a.rs', 'fn main() {}\n', [])
    expect(small.map((b) => [b.kind, b.startLine, b.endLine, b.embedText])).toEqual([['file', 1, 1, 'a.rs\nfn main() {}\n']])

    const body = Array.from({ length: SMALL_FILE_MAX_LINES }, (_, i) => `  m${i}() { return ${i} }`)
    const content = ['export class Big {', ...body, '}', 'export function after() {}', ''].join('\n')
    const last = SMALL_FILE_MAX_LINES + 3
    const symbols = [
      sym('Big', 1, SMALL_FILE_MAX_LINES + 2, { kind: 'class' }),
      ...body.map((_, i) => sym(`m${i}`, i + 2, i + 2, { kind: 'method', parent: 'Big', exported: false })),
      sym('after', last, last),
    ]
    const blocks = codeBlocks(FILE, 'src/big.ts', content, symbols)
    expect(blocks[0]).toMatchObject({ kind: 'skeleton', innerPath: '', startLine: 1, endLine: last, budgetTier: null })
    expect(blocks[0]!.embedText.split('\n').slice(0, 3)).toEqual(['src/big.ts', 'export class Big {', '  m0() { return 0 }'])
    const classSkeleton = blocks.find((b) => b.kind === 'skeleton' && b.innerPath === 'Big')!
    expect(classSkeleton).toMatchObject({ startLine: 1, endLine: SMALL_FILE_MAX_LINES + 2, outlineOf: 1 })
    expect(classSkeleton.embedText.split('\n').slice(0, 3)).toEqual(['class Big in src/big.ts', 'export class Big {', '  m0() { return 0 }'])
    expect(blocks.filter((b) => b.kind === 'file')).toEqual([])
    expect(blocks.filter((b) => b.kind === 'symbol')).toHaveLength(symbols.length)
  })

  it('a block hashes and embeds the exact text of its lines: CRLF and blank lines kept', () => {
    const content = 'export function spaced() {\r\n\r\n\r\n  return 1\r\n}\r\n'
    const [, block] = codeBlocks(FILE, 'src/crlf.ts', content, [sym('spaced', 1, 5)])
    expect(block!.embedText).toBe('function spaced in src/crlf.ts\nexport function spaced() {\r\n\r\n\r\n  return 1\r\n}\r')
    expect(content.includes(block!.embedText.split('\n').slice(1).join('\n'))).toBe(true)
  })

  it('an empty file has one file block spanning no line', () => {
    expect(codeBlocks(FILE, 'empty.txt', '', []).map((b) => [b.kind, b.startLine, b.endLine])).toEqual([['file', 1, 0]])
  })
})
