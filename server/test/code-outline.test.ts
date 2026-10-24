// #464: a repository's Markdown and HTML files get heading outlines: one
// `section` block per heading (inner path = the heading path, as a note's),
// so search can land on a section of a long README instead of the whole file.
// Sections are not symbols: find_symbols never lists them.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codeBlocks, SMALL_FILE_MAX_LINES } from '../src/repositories/code-blocks.js'
import { hasOutline, outlineSections } from '../src/repositories/outline.js'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/languages/${name}`, import.meta.url), 'utf8')
const FILE = '00000000-0000-4000-8000-000000000464'

describe('outlineSections (#464)', () => {
  it('only Markdown and HTML have outlines', () => {
    expect(['markdown', 'html', 'typescript', 'rust', null].map(hasOutline)).toEqual([true, true, false, false, false])
  })

  it('Markdown: ATX headings outside fences and front matter, each through the next heading of its level or higher', () => {
    expect(outlineSections('markdown', fixture('guide.md'))).toEqual([
      { innerPath: 'Elara guide', startLine: 5, ownEndLine: 8, endLine: 23 },
      { innerPath: 'Elara guide > Install', startLine: 9, ownEndLine: 15, endLine: 19 },
      { innerPath: 'Elara guide > Install > From source', startLine: 16, ownEndLine: 19, endLine: 19 },
      { innerPath: 'Elara guide > Usage', startLine: 20, ownEndLine: 23, endLine: 23 },
      { innerPath: 'Appendix', startLine: 24, ownEndLine: 24, endLine: 24 },
    ])
  })

  it('HTML: h1-h6 outside comments, scripts and styles, titles as text (tags dropped, entities decoded, spaces collapsed)', () => {
    expect(outlineSections('html', fixture('page.html'))).toEqual([
      { innerPath: 'Elara & friends', startLine: 8, ownEndLine: 10, endLine: 19 },
      { innerPath: 'Elara & friends > Install v2', startLine: 11, ownEndLine: 13, endLine: 15 },
      { innerPath: 'Elara & friends > Install v2 > From source', startLine: 14, ownEndLine: 15, endLine: 15 },
      { innerPath: 'Elara & friends > Usage', startLine: 16, ownEndLine: 19, endLine: 19 },
    ])
  })

  it('a file without headings, or of another language, has none', () => {
    expect(outlineSections('markdown', 'just text\n')).toEqual([])
    expect(outlineSections('html', '<p>no headings</p>')).toEqual([])
    expect(outlineSections('typescript', '# not markdown\n')).toEqual([])
  })
})

describe('section blocks (#464)', () => {
  it('a Markdown file keeps its file block and gains one section block per heading, under the embed budget as module-level', () => {
    const content = fixture('guide.md')
    const blocks = codeBlocks(FILE, 'docs/guide.md', content, [], outlineSections('markdown', content))
    expect(blocks.map((b) => [b.kind, b.innerPath, b.startLine, b.endLine, b.symbolKind, b.budgetTier])).toEqual([
      ['file', '', 1, 24, null, null],
      ['section', 'Elara guide', 5, 23, null, 1],
      ['section', 'Elara guide > Install', 9, 19, null, 1],
      ['section', 'Elara guide > Install > From source', 16, 19, null, 1],
      ['section', 'Elara guide > Usage', 20, 23, null, 1],
      ['section', 'Appendix', 24, 24, null, 1],
    ])
    // Its own text only (up to its first child heading), under a header naming it.
    expect(blocks[2]!.embedText).toBe(['section Elara guide > Install in docs/guide.md', '## Install', '', '```sh', '# not a heading: inside a fence', 'pnpm install', '```', ''].join('\n'))
    expect(new Set(blocks.map((b) => b.blockId)).size).toBe(blocks.length)
  })

  it('a large Markdown file gets a skeleton of its heading lines as its file-level block', () => {
    const filler = Array.from({ length: SMALL_FILE_MAX_LINES }, (_, i) => `line ${i}`)
    const content = ['# Big', ...filler, '## Tail', 'end', ''].join('\n')
    const blocks = codeBlocks(FILE, 'docs/big.md', content, [], outlineSections('markdown', content))
    expect(blocks[0]).toMatchObject({ kind: 'skeleton', innerPath: '', embedText: 'docs/big.md\n# Big\n## Tail' })
    expect(blocks.slice(1).map((b) => [b.kind, b.innerPath])).toEqual([
      ['section', 'Big'],
      ['section', 'Big > Tail'],
    ])
  })
})
