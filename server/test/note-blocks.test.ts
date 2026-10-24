// ADR-004 §2.2, §2.5 (#452): how a note body is cut into blocks
// (notes/note-blocks.ts), pure. Body-relative lines, `inner_path` = heading
// titles joined with ` > `, a section's embedded text is its own text (up to
// its first child heading) under the path and heading path, never the
// frontmatter; a long section is cut into pieces that share its inner path.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { NOTE_CHUNK_CHARS, noteBlocks } from '../src/notes/note-blocks.js'
import { blockId } from '../src/text/blocks.js'
import { sliceLines } from '../src/text/lines.js'

const ID = '00000000-0000-4000-8000-000000000001'
const PATH = 'concepts/fruit'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('noteBlocks', () => {
  it('preamble and sections: spans, inner paths, ids, hashes and embedded texts', () => {
    const body = 'Intro.\n\n# Alpha\nAlpha text.\n## Beta\nBeta text.\n### Gamma\nGamma text.\n## Delta\nDelta text.\n# Omega\nOmega text.\n'
    const blocks = noteBlocks(ID, PATH, body)
    expect(blocks.map((b) => [b.kind, b.innerPath, b.startLine, b.endLine])).toEqual([
      ['preamble', '', 1, 2],
      ['section', 'Alpha', 3, 10],
      ['section', 'Alpha > Beta', 5, 8],
      ['section', 'Alpha > Beta > Gamma', 7, 8],
      ['section', 'Alpha > Delta', 9, 10],
      ['section', 'Omega', 11, 12],
    ])
    expect(blocks.map((b) => b.embedText)).toEqual([
      `${PATH}\nIntro.\n`,
      `${PATH}\nAlpha\n# Alpha\nAlpha text.`,
      `${PATH}\nAlpha > Beta\n## Beta\nBeta text.`,
      `${PATH}\nAlpha > Beta > Gamma\n### Gamma\nGamma text.`,
      `${PATH}\nAlpha > Delta\n## Delta\nDelta text.`,
      `${PATH}\nOmega\n# Omega\nOmega text.`,
    ])
    for (const b of blocks) {
      expect(b.contentHash).toBe(sha(sliceLines(body, b.startLine, b.endLine)))
      expect(b.blockId).toBe(blockId(ID, b.kind, b.innerPath, 0))
    }
  })

  it('a deeper heading before a shallower one: the path follows the levels', () => {
    const blocks = noteBlocks(ID, PATH, '# A\n### Deep\nx\n## B\ny\n')
    expect(blocks.map((b) => [b.innerPath, b.startLine, b.endLine])).toEqual([
      ['A', 1, 5],
      ['A > Deep', 2, 3],
      ['A > B', 4, 5],
    ])
  })

  it('no preamble when only blank lines precede the first heading; fenced headings are text', () => {
    const blocks = noteBlocks(ID, PATH, '\n\n# Only\n~~~\n# fenced\n~~~\n')
    expect(blocks.map((b) => [b.kind, b.innerPath, b.startLine, b.endLine])).toEqual([['section', 'Only', 3, 6]])
    expect(blocks[0]!.embedText).toContain('# fenced')
  })

  it('duplicate headings get sibling indexes 0 and 1', () => {
    const blocks = noteBlocks(ID, PATH, '# Log\na\n# Log\nb\n')
    expect(blocks.map((b) => b.blockId)).toEqual([blockId(ID, 'section', 'Log', 0), blockId(ID, 'section', 'Log', 1)])
  })

  it('an empty or heading-less blank body is one preamble embedded as the path, so the note keeps a vector', () => {
    expect(noteBlocks(ID, PATH, '').map((b) => [b.kind, b.startLine, b.endLine, b.embedText])).toEqual([['preamble', 1, 0, PATH]])
    expect(noteBlocks(ID, PATH, '\n\n').map((b) => [b.kind, b.startLine, b.endLine])).toEqual([['preamble', 1, 2]])
  })

  it('a long section is cut on line boundaries into pieces of at most NOTE_CHUNK_CHARS, the last one carrying the children', () => {
    const line = 'x'.repeat(99)
    const own = Array.from({ length: 50 }, () => line) // 50 lines of 100 chars with their newlines
    const body = ['# Long', ...own, '## Child', 'child text', ''].join('\n')
    const blocks = noteBlocks(ID, PATH, body)
    const pieces = blocks.filter((b) => b.innerPath === 'Long')
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.map((b) => b.blockId)).toEqual(pieces.map((_, i) => blockId(ID, 'section', 'Long', i)))
    // Consecutive, from the heading line to the end of the section (the child's lines too).
    expect(pieces[0]!.startLine).toBe(1)
    for (let i = 1; i < pieces.length; i++) expect(pieces[i]!.startLine).toBe(pieces[i - 1]!.endLine + 1)
    expect(pieces.at(-1)!.endLine).toBe(53)
    for (const p of pieces) {
      const text = p.embedText.slice(`${PATH}\nLong\n`.length)
      expect(text.length).toBeLessThanOrEqual(NOTE_CHUNK_CHARS)
      expect(text).not.toContain('child text')
    }
    expect(blocks.find((b) => b.innerPath === 'Long > Child')!.embedText).toBe(`${PATH}\nLong > Child\n## Child\nchild text`)
  })

  it('CRLF bodies keep their bytes in hashes and texts', () => {
    const body = '# A\r\ntext\r\n'
    const [a] = noteBlocks(ID, PATH, body)
    expect(a!.embedText).toBe(`${PATH}\nA\n# A\r\ntext\r`)
    expect(a!.contentHash).toBe(sha('# A\r\ntext\r'))
  })
})
