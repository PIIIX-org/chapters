import { describe, expect, it } from 'vitest'
import {
  extractWikilinks,
  OkfValidationError,
  parseNote,
  serializeNote,
  validateNote,
  type Frontmatter,
  type OkfNote,
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

  it('rejects malformed tags and nested values', () => {
    expect(() =>
      validateNote('a', 'b', { type: 'a', tags: 'not-array' as unknown as string[] }, ''),
    ).toThrow(OkfValidationError)
    expect(() => validateNote('a', 'b', { type: 'a', nested: { deep: true } }, '')).toThrow(
      'frontmatter key "nested" must be a scalar or list of scalars',
    )
  })

  it('validates ISO 8601 timestamps with explicit UTC/offset strictly', () => {
    // Date-only timestamp must be rejected
    expect(() =>
      validateNote('a', 'b', { type: 'a', timestamp: '2026-07-17' }, ''),
    ).toThrow('timestamp must be an ISO 8601 datetime with explicit UTC/offset')

    // Timestamp without offset must be rejected
    expect(() =>
      validateNote('a', 'b', { type: 'a', timestamp: '2026-07-17T00:00:00' }, ''),
    ).toThrow('timestamp must be an ISO 8601 datetime with explicit UTC/offset')

    // Non-date string must be rejected
    expect(() =>
      validateNote('a', 'b', { type: 'a', timestamp: 'not-a-date' }, ''),
    ).toThrow('timestamp must be an ISO 8601 datetime with explicit UTC/offset')

    // Valid timestamps with 'Z', '+00:00', '-05:00' must be accepted
    expect(() =>
      validateNote('a', 'b', { type: 'a', timestamp: '2026-07-17T00:00:00Z' }, ''),
    ).not.toThrow()
    expect(() =>
      validateNote('a', 'b', { type: 'a', timestamp: '2026-07-17T00:00:00+00:00' }, ''),
    ).not.toThrow()
    expect(() =>
      validateNote('a', 'b', { type: 'a', timestamp: '2026-07-17T14:30:00-05:00' }, ''),
    ).not.toThrow()
    expect(() =>
      validateNote('a', 'b', { type: 'a', timestamp: '2026-07-17T14:30:00.123+02:00' }, ''),
    ).not.toThrow()
  })

  it('validates stale_after as ISO 8601 datetime with explicit UTC/offset', () => {
    expect(() =>
      validateNote('a', 'b', { type: 'a', stale_after: '2026-07-17' }, ''),
    ).toThrow('stale_after must be an ISO 8601 datetime with explicit UTC/offset')
    expect(() =>
      validateNote('a', 'b', { type: 'a', stale_after: '2026-07-17T00:00:00' }, ''),
    ).toThrow('stale_after must be an ISO 8601 datetime with explicit UTC/offset')
    expect(() =>
      validateNote('a', 'b', { type: 'a', stale_after: '2026-07-17T00:00:00Z' }, ''),
    ).not.toThrow()
  })

  it('accepts valid OKF v0.2 frontmatter', () => {
    const v2Frontmatter: Frontmatter = {
      type: 'specs',
      title: 'OKF v0.2 Spec',
      description: 'Specification for OKF v0.2 engine validation',
      status: 'active',
      resource: 'https://example.com/spec',
      tags: ['okf', 'v02'],
      timestamp: '2026-07-17T12:00:00Z',
      stale_after: '2027-01-01T00:00:00+00:00',
      generated: {
        by: 'agent-1',
        at: '2026-07-17T12:00:00Z',
      },
      sources: [
        {
          id: 'src-1',
          resource: 'file:///repo/src/core.ts',
          title: 'Core Engine',
          hash: 'abc123',
          last_modified: '2026-07-16T18:00:00-05:00',
          author: 'alice',
          usage_count: 5,
        },
      ],
      verified: [
        {
          tier: 'human-reviewed',
          by: 'reviewer-1',
          at: '2026-07-17T14:00:00Z',
        },
        {
          tier: 'machine-confirmed',
        },
      ],
      usage_window: {
        from: '2026-07-17T00:00:00Z',
        to: '2026-12-31T23:59:59Z',
      },
      properties: {
        custom_rating: 4.5,
        arbitrary_data: { nested_key: 'nested_val' },
      },
    }

    expect(() => validateNote('specs', 'okf-v02', v2Frontmatter, '# Spec Content')).not.toThrow()

    // Single verified object is also supported
    expect(() =>
      validateNote(
        'specs',
        'okf-v02',
        {
          type: 'specs',
          verified: { tier: 'machine-confirmed' },
        },
        '',
      ),
    ).not.toThrow()
  })

  it('rejects invalid generated metadata', () => {
    // Missing at
    expect(() =>
      validateNote('a', 'b', { type: 'a', generated: { by: 'agent' } as unknown as { by: string; at: string } }, ''),
    ).toThrow(OkfValidationError)
    // Bad at
    expect(() =>
      validateNote('a', 'b', { type: 'a', generated: { by: 'agent', at: '2026-07-17' } }, ''),
    ).toThrow(OkfValidationError)
    // Non-object
    expect(() =>
      validateNote('a', 'b', { type: 'a', generated: 'agent' as unknown as { by: string; at: string } }, ''),
    ).toThrow(OkfValidationError)
  })

  it('rejects invalid sources', () => {
    // Missing resource
    expect(() =>
      validateNote('a', 'b', { type: 'a', sources: [{ title: 'no resource' }] as unknown as [{ resource: string }] }, ''),
    ).toThrow(OkfValidationError)
    // Bad last_modified
    expect(() =>
      validateNote('a', 'b', { type: 'a', sources: [{ resource: 'file:///x', last_modified: '2026-07-17' }] }, ''),
    ).toThrow(OkfValidationError)
    // Non-array
    expect(() =>
      validateNote('a', 'b', { type: 'a', sources: { resource: 'file:///x' } as unknown as [{ resource: string }] }, ''),
    ).toThrow(OkfValidationError)
  })

  it('rejects invalid verified metadata', () => {
    // Bad tier
    expect(() =>
      validateNote('a', 'b', { type: 'a', verified: { tier: 'invalid-tier' as unknown as 'unverified' } }, ''),
    ).toThrow(OkfValidationError)
    // Bad at
    expect(() =>
      validateNote('a', 'b', { type: 'a', verified: { tier: 'machine-confirmed', at: 'not-iso' } }, ''),
    ).toThrow(OkfValidationError)
    // Array with an invalid item
    expect(() =>
      validateNote(
        'a',
        'b',
        {
          type: 'a',
          verified: [{ tier: 'unverified' }, { tier: 'not-real' as unknown as 'unverified' }],
        },
        '',
      ),
    ).toThrow(OkfValidationError)
  })

  it('rejects invalid status, usage_window, and properties', () => {
    expect(() =>
      validateNote('a', 'b', { type: 'a', status: 'invalid-status' as unknown as 'active' }, ''),
    ).toThrow(OkfValidationError)

    expect(() =>
      validateNote('a', 'b', { type: 'a', usage_window: { to: '2026-07-17T00:00:00Z' } as unknown as { from: string } }, ''),
    ).toThrow(OkfValidationError)

    expect(() =>
      validateNote('a', 'b', { type: 'a', usage_window: { from: '2026-07-17' } }, ''),
    ).toThrow(OkfValidationError)

    expect(() =>
      validateNote('a', 'b', { type: 'a', properties: 'not-object' as unknown as Record<string, unknown> }, ''),
    ).toThrow(OkfValidationError)
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

  it('roundtrips nested OKF v0.2 frontmatter through serializeNote and parseNote', () => {
    const note: OkfNote = {
      frontmatter: {
        type: 'specs',
        title: 'Nested Test',
        status: 'active',
        timestamp: '2026-07-17T12:00:00Z',
        generated: {
          by: 'agent-42',
          at: '2026-07-17T12:00:00Z',
        },
        sources: [
          {
            resource: 'file:///main.ts',
            title: 'Main',
            last_modified: '2026-07-16T18:00:00-05:00',
          },
        ],
        verified: {
          tier: 'human-reviewed',
          by: 'alice',
          at: '2026-07-17T14:00:00Z',
        },
        usage_window: {
          from: '2026-01-01T00:00:00Z',
          to: '2026-12-31T23:59:59Z',
        },
        properties: {
          metadata: { score: 100, enabled: true },
        },
      },
      body: '# Body with nested frontmatter\n\nContent here.\n',
    }
    const serialized = serializeNote(note)
    const parsed = parseNote(serialized)
    expect(parsed.frontmatter).toEqual(note.frontmatter)
    expect(parsed.body).toBe(note.body)
    expect(() => validateNote('specs', 'nested-test', parsed.frontmatter, parsed.body)).not.toThrow()
  })

  it('extracts unique wikilink targets, ignoring aliases and headings', () => {
    const body = 'See [[projects/apollo]] and [[people/jane|Jane]] and [[projects/apollo#goals]].'
    expect(extractWikilinks(body).sort()).toEqual(['people/jane', 'projects/apollo'])
  })
})
