import { describe, expect, it } from 'vitest'
import {
  extractWikilinks,
  OkfValidationError,
  parseNote,
  serializeNote,
  validateNote,
} from '../src/notes/okf.js'

describe('OKF validation', () => {
  it('accepts a valid note', () => {
    expect(() =>
      validateNote(
        'people',
        'john-doe',
        { type: 'people', tags: ['team'], timestamp: '2026-07-17T00:00:00Z' },
        'body',
      ),
    ).not.toThrow()
  })

  it('rejects path traversal and non-slug segments', () => {
    for (const bad of ['../etc', 'a/b', 'UPPER', 'sp ace', '.hidden', '']) {
      expect(() => validateNote(bad, 'name', { type: bad }, ''), bad).toThrow(OkfValidationError)
    }
    expect(() => validateNote('people', '../../x', { type: 'people' }, '')).toThrow(
      OkfValidationError,
    )
  })

  it('rejects frontmatter type mismatching the path', () => {
    expect(() => validateNote('people', 'x', { type: 'projects' }, '')).toThrow(
      OkfValidationError,
    )
  })

  it('rejects malformed tags, timestamp, and nested values', () => {
    expect(() =>
      validateNote('a', 'b', { type: 'a', tags: 'not-array' as unknown as string[] }, ''),
    ).toThrow(OkfValidationError)
    expect(() => validateNote('a', 'b', { type: 'a', timestamp: 'not-a-date' }, '')).toThrow(
      OkfValidationError,
    )
    expect(() => validateNote('a', 'b', { type: 'a', nested: { deep: true } }, '')).toThrow(
      OkfValidationError,
    )
  })

  it('serialize → parse roundtrips', () => {
    const note = {
      frontmatter: { type: 'people', tags: ['x', 'y'], resource: 'https://e.co' },
      body: '# John\n\nLinks to [[projects/apollo]].\n',
    }
    const parsed = parseNote(serializeNote(note))
    expect(parsed.frontmatter).toEqual(note.frontmatter)
    expect(parsed.body).toBe(note.body)
  })

  it('extracts unique wikilink targets, ignoring aliases and headings', () => {
    const body = 'See [[projects/apollo]] and [[people/jane|Jane]] and [[projects/apollo#goals]].'
    expect(extractWikilinks(body).sort()).toEqual(['people/jane', 'projects/apollo'])
  })
})
