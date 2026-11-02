// #674: the routing table of mcp/routing-hints.ts, one case per rule and per exception.
import { describe, expect, it } from 'vitest'
import { LONG_TEXT_LINES, routingHint } from '../src/mcp/routing-hints.js'

const search = (query: string, vaults = 0, repositories = 1) => routingHint({ tool: 'search', query, vaults, repositories })
const read = (over: Partial<{ lines: number; targets: boolean; outline: boolean; continued: boolean }> = {}, tool: 'read_file' | 'read_note' = 'read_file') =>
  routingHint({ tool, lines: 1_000, targets: false, outline: false, continued: false, ...over })

describe('routing hints (#674)', () => {
  it('search: literal text in one repository gets the rg hint with the text', () => {
    expect(search('"connection reset by peer"')).toBe('exact text, not meaning: in a checked-out repo `rg -n -F "connection reset by peer"` lists every occurrence for less than a ranked search')
    expect(search('foo(bar) => baz')).toContain('rg -n -F "foo(bar) => baz"')
    expect(search('std::move')).toContain('rg -n -F')
    expect(search('a\\.b')).toContain('rg -n -F "a\\\\.b"')
  })

  it('search: meaning, names and paths get none', () => {
    for (const q of ['how does the upload retry work?', 'normalize', 'Store.save', 'src/store.ts', 'why is auth slow, again', "don't panic", '']) expect(search(q), q).toBeUndefined()
    expect(search('x'.repeat(81) + '()')).toBeUndefined()
    expect(search('a(\nb)')).toBeUndefined()
  })

  it('search: a vault or several repositories never get it, whatever the query', () => {
    expect(search('"TODO"', 1, 0)).toBeUndefined()
    expect(search('"TODO"', 1, 1)).toBeUndefined()
    expect(search('"TODO"', 0, 2)).toBeUndefined()
    expect(search('"TODO"', 0, 0)).toBeUndefined()
  })

  it('read: a long text read from the top without targets or outline gets the outline hint, notes too', () => {
    expect(read()).toBe('1000 lines: `outline: true`, then `targets`, cost less than every page')
    expect(read({}, 'read_note')).toContain('1000 lines')
    expect(read({ lines: LONG_TEXT_LINES + 1 })).toBeDefined()
  })

  it('read: short texts, targets, outline and later pages get none', () => {
    expect(read({ lines: LONG_TEXT_LINES })).toBeUndefined()
    expect(read({ targets: true })).toBeUndefined()
    expect(read({ outline: true })).toBeUndefined()
    expect(read({ continued: true })).toBeUndefined()
  })

  it('is deterministic: the same request, the same hint', () => {
    expect(search('"a b"')).toBe(search('"a b"'))
  })
})
