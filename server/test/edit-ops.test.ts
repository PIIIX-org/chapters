// #408 item 72: edit_note ops resolved against a text (edit-ops.ts). The MCP
// round trip is in edit-note-ops.test.ts; these are the edge cases.
import { describe, expect, it } from 'vitest'
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

describe('applyFrontmatterOps', () => {
  it('refuses list ops on a value that is not a list, and the type key', () => {
    expect(() => applyFrontmatterOps({ title: 'x' }, [{ op: 'frontmatter_add', key: 'title', value: 'y' }])).toThrow(/not a list/)
    expect(() => applyFrontmatterOps({}, [{ op: 'frontmatter_set', key: 'type', value: 'other' }])).toThrow(/`type` is the note's folder/)
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
