// #674: the routing table of mcp/routing-hints.ts, one case per rule and per exception.
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { LONG_TEXT_LINES, routingHint, withHint } from '../src/mcp/routing-hints.js'

const search = (query: string, vaults = 0, repositories = 1) => routingHint({ tool: 'search', query, vaults, repositories })
const read = (over: Partial<{ lines: number; targets: boolean; outline: boolean; continued: boolean; structured: boolean }> = {}, tool: 'read_file' | 'read_note' = 'read_file') =>
  routingHint({ tool, lines: 1_000, targets: false, outline: false, continued: false, structured: true, ...over })

describe('routing hints (#674)', () => {
  it('search: a quoted phrase or one code-like token in one repository gets the rg hint, single-quoted after `--`', () => {
    expect(search('"connection reset by peer"')).toBe("exact text, not meaning: in a checked-out repo `rg -n -F -- 'connection reset by peer'` lists every occurrence for less than a ranked search")
    expect(search('foo(bar)')).toContain("rg -n -F -- 'foo(bar)'")
    expect(search('std::move')).toContain("-- 'std::move'")
    expect(search('a=>b')).toContain("-- 'a=>b'")
    expect(search('C++')).toContain("-- 'C++'")
    expect(search('"it\'s"')).toContain("-- 'it'\\''s'")
  })

  it('search: the text is inert in a POSIX shell: $(cmd), ${HOME}, backticks, `!`, a leading `-`, quotes, a backslash', () => {
    for (const text of ['$(touch /tmp/pwned-674)', '${HOME}', '`id`', 'a!b', '-rf (x)', "it's (x)", 'a\\b$x', '"; rm -rf ~ #(']) {
      const hint = search(`'${text}'`.replace(/^'(.*'.*)'$/, '"$1"'))!
      const arg = /-- ('(?:[^']|'\\'')*')`/.exec(hint)![1]!
      expect(execFileSync('sh', ['-c', `printf %s ${arg}`]).toString(), text).toBe(text)
    }
  })

  it('search: prose, even with a bracket or an operator in it, meaning, names, paths and lone quotes get none', () => {
    for (const q of [
      'how does the upload retry work?',
      'how does retry (backoff) work',
      'why is a=b slow',
      'C++ vs Rust',
      'foo(bar) => baz',
      'normalize',
      'Store.save',
      'src/store.ts',
      'why is auth slow, again',
      "don't panic",
      "it's a 'trap",
      "'",
      '`',
      '"',
      '""',
      '',
    ])
      expect(search(q), q).toBeUndefined()
    expect(search('x'.repeat(81) + '()')).toBeUndefined()
    expect(search('a(\nb)')).toBeUndefined()
  })

  it("search: a vault or several repositories never get it, whatever the query", () => {
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

  it('read: a long text with no outline (JSON, a lockfile, a log) is pointed at line targets', () => {
    expect(read({ structured: false })).toBe('1000 lines: `targets: [{lines: "a-b"}]` costs less than every page')
  })

  it('read: short texts, targets, outline and later pages get none', () => {
    expect(read({ lines: LONG_TEXT_LINES })).toBeUndefined()
    expect(read({ targets: true })).toBeUndefined()
    expect(read({ outline: true })).toBeUndefined()
    expect(read({ continued: true })).toBeUndefined()
  })

  it('withHint: adds the hint to the head, but not to a session reference or without a hint', () => {
    const answer = { head: { path: 'a' }, sections: [{ kind: 'text' }] }
    expect(withHint(answer, 'h').head).toEqual({ path: 'a', hint: 'h' })
    expect(withHint(answer, undefined)).toBe(answer)
    const ref = { head: { path: 'a' }, sections: [{ kind: 'text', ref: { same_as: {} } }] }
    expect(withHint(ref, 'h')).toBe(ref)
  })

  it('is deterministic: the same request, the same hint', () => {
    expect(search('"a b"')).toBe(search('"a b"'))
  })
})
