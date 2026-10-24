// #408 item 72: edit_note ops resolved against a text (edit-ops.ts). The MCP
// round trip is in edit-note-ops.test.ts; these are the edge cases.
import { describe, expect, it } from 'vitest'
import { config } from '../src/config.js'
import { NoteTooLargeError } from '../src/notes/size-cap.js'
import { applyBodyOps, applyFrontmatterOps, NoteEditError } from '../src/sync/edit-ops.js'

describe('applyBodyOps', () => {
  it('append and prepend add whole lines', () => {
    expect(applyBodyOps('no newline', [{ op: 'append', text: 'next' }])).toBe('no newline\nnext\n')
    expect(applyBodyOps('', [{ op: 'append', text: 'first' }])).toBe('first\n')
    expect(applyBodyOps('body\n', [{ op: 'append', text: 'two\nlines\n' }])).toBe('body\ntwo\nlines\n')
    expect(applyBodyOps('body\n', [{ op: 'prepend', text: 'top' }])).toBe('top\nbody\n')
  })

  it('replace_text keeps `$` patterns in the replacement literal', () => {
    expect(applyBodyOps('cost: X\n', [{ op: 'replace_text', find: 'X', replace: "$& $1 $$ $'" }])).toBe("cost: $& $1 $$ $'\n")
  })

  it('delete_block takes the line break of a whole line with it', () => {
    expect(applyBodyOps('- one\n- two\n- three\n', [{ op: 'delete_block', find: '- two' }])).toBe('- one\n- three\n')
    expect(applyBodyOps('keep this word here\n', [{ op: 'delete_block', find: ' word' }])).toBe('keep this here\n')
  })

  it('replace_section ignores headings in code fences and handles the last section', () => {
    const body = '# A\n\n```md\n## B\nfenced\n```\n\n## B\n\nold\n\n## C\n\nlast'
    expect(applyBodyOps(body, [{ op: 'replace_section', heading: 'B', content: 'new' }])).toBe(
      '# A\n\n```md\n## B\nfenced\n```\n\n## B\n\nnew\n\n## C\n\nlast',
    )
    expect(applyBodyOps(body, [{ op: 'replace_section', heading: '## C', content: 'end' }])).toBe(
      '# A\n\n```md\n## B\nfenced\n```\n\n## B\n\nold\n\n## C\n\nend\n',
    )
    expect(applyBodyOps('# Only', [{ op: 'replace_section', heading: 'Only', content: 'text' }])).toBe('# Only\n\ntext\n')
  })

  it('names the op and the reason when it cannot resolve, and the heading choices', () => {
    const refuse = (body: string, ops: Parameters<typeof applyBodyOps>[1]): string => {
      try {
        applyBodyOps(body, ops)
      } catch (err) {
        expect(err).toBeInstanceOf(NoteEditError)
        return err instanceof Error ? err.message : String(err)
      }
      throw new Error('expected a refusal')
    }
    expect(refuse('x', [{ op: 'replace_text', find: '', replace: 'y' }])).toMatch(/ops\[0\] replace_text: `find` is empty/)
    expect(refuse('x\n', [{ op: 'append', text: 'ok' }, { op: 'insert_before', anchor: '', text: 'y' }])).toMatch(/ops\[1\] insert_before: `anchor` is empty/)
    expect(refuse('## A\n## A\n', [{ op: 'replace_section', heading: 'A', content: '' }])).toMatch(/occurs 2 times; give the whole heading line/)
    expect(refuse('## A\n### B\n', [{ op: 'replace_section', heading: 'Z', content: '' }])).toMatch(/its headings: "## A", "### B"/)
  })
})

describe('applyBodyOps and the size cap (#491)', () => {
  /** The error `ops` throw on `body`; fails the test when they do not throw. */
  const thrown = (body: string, ops: Parameters<typeof applyBodyOps>[1]): unknown => {
    try {
      applyBodyOps(body, ops)
    } catch (err) {
      return err
    }
    throw new Error('expected a refusal')
  }

  it('refuses a replace_text whose result is over the cap before building it', () => {
    // 200 matches of a 5 MB replacement: 1e9 characters, past V8's longest
    // string, so building it throws a RangeError (and below that, takes
    // hundreds of megabytes) instead of the size error.
    const err = thrown('x\n'.repeat(200), [{ op: 'replace_text', find: 'x', replace: 'y'.repeat(5_000_000), expectedCount: 200 }])
    expect(err).toBeInstanceOf(NoteTooLargeError)
    expect((err as Error).message).toMatch(/^ops\[0\] replace_text: note body would be at least \d+ bytes \(UTF-8\); the limit is/)
  })

  it('refuses insert, append, prepend and replace_section results over the cap', () => {
    const near = 'a'.repeat(config.noteMaxBytes - 4)
    const big = 'b'.repeat(10)
    expect(thrown(`${near}\n`, [{ op: 'append', text: big }])).toBeInstanceOf(NoteTooLargeError)
    expect(thrown(`${near}\n`, [{ op: 'prepend', text: big }])).toBeInstanceOf(NoteTooLargeError)
    expect(thrown(`${near}\n`, [{ op: 'insert_after', anchor: '\n', text: big }])).toBeInstanceOf(NoteTooLargeError)
    expect(thrown(`# H\n${near}`, [{ op: 'replace_section', heading: 'H', content: `${near}${big}` }])).toBeInstanceOf(NoteTooLargeError)
    // Within the cap, and a note already over it that does not grow, still apply.
    expect(applyBodyOps('a\n', [{ op: 'append', text: 'b' }])).toBe('a\nb\n')
    const pairs = (config.noteMaxBytes + 10) / 2
    expect(applyBodyOps('cd'.repeat(pairs), [{ op: 'replace_text', find: 'cd', replace: 'e', expectedCount: pairs }])).toHaveLength(pairs)
  })
})

describe('applyBodyOps resolution', () => {
  it('counts overlapping matches as ambiguous', () => {
    expect(() => applyBodyOps('xaaay\n', [{ op: 'insert_after', anchor: 'aa', text: 'X' }])).toThrow(/"aa" occurs 2 times/)
    expect(() => applyBodyOps('ababa\n', [{ op: 'replace_text', find: 'aba', replace: 'c' }])).toThrow(/occurrences of "aba" overlap/)
    expect(applyBodyOps('abab\n', [{ op: 'replace_text', find: 'ab', replace: 'c', expectedCount: 2 }])).toBe('cc\n')
  })

  it('refuses a find or anchor holding half a surrogate pair', () => {
    expect(() => applyBodyOps('a😀b\n', [{ op: 'insert_after', anchor: '\ud83d', text: 'X' }])).toThrow(/half of a UTF-16 surrogate pair/)
    expect(() => applyBodyOps('a😀b\n', [{ op: 'replace_text', find: '\ude00', replace: 'X' }])).toThrow(/half of a UTF-16 surrogate pair/)
    expect(applyBodyOps('a😀b\n', [{ op: 'insert_after', anchor: '😀', text: 'X' }])).toBe('a😀Xb\n')
  })

  it('replace_section matches a heading with closing hashes, and a fence closes only without an info string', () => {
    expect(applyBodyOps('## Plan ##\n\nold\n', [{ op: 'replace_section', heading: '## Plan', content: 'new' }])).toBe('## Plan ##\n\nnew\n')
    const fenced = '```md\n```js\n## Inside\n```\n\n## Inside\n\nold\n'
    expect(applyBodyOps(fenced, [{ op: 'replace_section', heading: 'Inside', content: 'new' }])).toBe('```md\n```js\n## Inside\n```\n\n## Inside\n\nnew\n')
  })
})

describe('applyFrontmatterOps', () => {
  it('refuses list ops on a value that is not a list, and sets the type key like any other (#444)', () => {
    expect(() => applyFrontmatterOps({ title: 'x' }, [{ op: 'frontmatter_add', key: 'title', value: 'y' }])).toThrow(/not a list/)
    expect(applyFrontmatterOps({ type: 'notes' }, [{ op: 'frontmatter_set', key: 'type', value: 'decision' }])).toEqual({ type: 'decision' })
  })

  it('compares list items by value, nested ones included', () => {
    const next = applyFrontmatterOps({ links: [{ to: 'a' }] }, [
      { op: 'frontmatter_add', key: 'links', value: { to: 'a' } },
      { op: 'frontmatter_add', key: 'links', value: { to: 'b' } },
      { op: 'frontmatter_remove', key: 'links', value: { to: 'a' } },
      { op: 'frontmatter_remove', key: 'missing', value: 'x' },
    ])
    expect(next).toEqual({ links: [{ to: 'b' }] })
  })
})
