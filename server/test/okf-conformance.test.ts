import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractWikilinks,
  isValidIsoDateTime,
  OkfValidationError,
  validateNote,
  type Frontmatter,
} from '../src/notes/okf.js'
import { resolveNotePath } from '../src/notes/okf/paths.js'
import { auditVaultConformance } from '../src/notes/audit.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const schemaDir = resolve(__dirname, '../../vendor/okf/schemas')

describe('OKF v0.2 Vendored Schemas', () => {
  it('vendors valid bundle, concept, and note schemas', async () => {
    const bundleRaw = await readFile(join(schemaDir, 'bundle.schema.json'), 'utf8')
    const conceptRaw = await readFile(join(schemaDir, 'concept.schema.json'), 'utf8')
    const noteRaw = await readFile(join(schemaDir, 'note.schema.json'), 'utf8')

    const bundleSchema = JSON.parse(bundleRaw)
    const conceptSchema = JSON.parse(conceptRaw)
    const noteSchema = JSON.parse(noteRaw)

    expect(bundleSchema.title).toContain('Bundle Schema')
    expect(bundleSchema.properties.okf_version.enum).toContain('0.2')

    expect(conceptSchema.title).toContain('Concept Document Schema')
    expect(conceptSchema.required).toEqual(['type'])
    expect(conceptSchema.properties.timestamp.pattern).toBeDefined()

    expect(noteSchema.title).toContain('Note Schema')
    expect(noteSchema.required).toEqual(['frontmatter', 'body'])
  })
})

describe('Strict ISO 8601 UTC / Offset Validation', () => {
  it('accepts compliant ISO 8601 UTC and offset formats', () => {
    const validTimestamps = [
      '2026-09-22T12:00:00Z',
      '2026-09-22T12:00:00.000Z',
      '2026-09-22T12:00:00.123456Z',
      '2026-09-22T08:30:00+00:00',
      '2026-09-22T14:00:00+02:00',
      '2026-09-22T17:30:00+03:30',
      '2026-09-22T05:00:00-07:00',
    ]

    for (const ts of validTimestamps) {
      expect(isValidIsoDateTime(ts), `Expected ${ts} to be valid`).toBe(true)
    }
  })

  it('rejects non-compliant timestamps (bare dates, missing offset, invalid formats)', () => {
    const invalidTimestamps = [
      '2026-09-22', // Bare date
      '2026-09-22T12:00:00', // Missing timezone offset
      '2026-09-22 12:00:00', // Missing T separator and offset
      '2026-13-45T12:00:00Z', // Out of bounds calendar date
      'invalid-date',
      '',
      1234567890,
      null,
      undefined,
      {},
    ]

    for (const ts of invalidTimestamps) {
      expect(isValidIsoDateTime(ts), `Expected ${String(ts)} to be invalid`).toBe(false)
    }
  })

  it('enforces ISO 8601 offset across all OKF frontmatter families in validateNote', () => {
    const validFm: Frontmatter = {
      type: 'concepts',
      title: 'Auth Spec',
      timestamp: '2026-09-22T10:00:00Z',
      stale_after: '2026-12-31T23:59:59Z',
      generated: {
        by: 'agent:antigravity',
        at: '2026-09-22T10:00:00Z',
      },
      sources: [
        {
          id: 'lead-file',
          resource: 'repo:chapters/server/src/auth.ts',
          last_modified: '2026-09-21T18:00:00Z',
        },
      ],
      verified: {
        tier: 'human-reviewed',
        by: 'human:taha',
        at: '2026-09-22T11:00:00Z',
      },
      usage_window: {
        from: '2026-09-22T00:00:00Z',
        to: '2026-12-31T00:00:00Z',
      },
    }

    expect(() => validateNote('concepts', 'auth-spec', validFm, 'Body content')).not.toThrow()

    // Invalid stale_after bare date
    expect(() =>
      validateNote(
        'concepts',
        'auth-spec',
        { ...validFm, stale_after: '2026-12-31' },
        'Body',
      ),
    ).toThrow(OkfValidationError)

    // Invalid generated.at without offset
    expect(() =>
      validateNote(
        'concepts',
        'auth-spec',
        { ...validFm, generated: { by: 'bot', at: '2026-09-22T10:00:00' } },
        'Body',
      ),
    ).toThrow(OkfValidationError)

    // Invalid source.last_modified
    expect(() =>
      validateNote(
        'concepts',
        'auth-spec',
        {
          ...validFm,
          sources: [{ resource: 'repo:main/file.ts', last_modified: 'yesterday' }],
        },
        'Body',
      ),
    ).toThrow(OkfValidationError)
  })
})

describe('audit_okf_conformance Engine', () => {
  const vaultId = '00000000-0000-0000-0000-000000000001'
  const userId = '00000000-0000-0000-0000-000000000002'

  it('calculates 100% conformance for fully compliant notes with index files and bidirectional links', async () => {
    const notes = [
      { path: 'index', name: 'index', type: 'index' },
      { path: 'domains/auth/session', name: 'auth/session', type: 'domains' },
      { path: 'domains/auth/tokens', name: 'auth/tokens', type: 'domains' },
    ]

    const contents: Record<string, { frontmatter: Frontmatter; body: string }> = {
      index: {
        frontmatter: {
          type: 'index',
          title: 'System Index',
          timestamp: '2026-09-22T00:00:00Z',
        },
        body: 'Welcome to [[domains/auth/session]] and [[domains/auth/tokens]]',
      },
      'domains/auth/session': {
        frontmatter: {
          type: 'domains',
          title: 'Session Management',
          timestamp: '2026-09-22T00:00:00Z',
          status: 'active',
          sources: [
            {
              resource: 'repo:chapters/server/src/session.ts',
              last_modified: '2026-09-22T00:00:00Z',
            },
          ],
        },
        body: 'Session token validation via [[domains/auth/tokens]] and [[repo:chapters/server/src/session.ts]].',
      },
      'domains/auth/tokens': {
        frontmatter: {
          type: 'domains',
          title: 'Token Service',
          timestamp: '2026-09-22T00:00:00Z',
        },
        body: 'Issues tokens for [[domains/auth/session]].',
      },
    }

    const result = await auditVaultConformance(vaultId, userId, {
      getNotes: async () => notes,
      readNoteContent: async (_, path) => contents[path] ?? null,
      checkRepoFile: async () => ({ accessible: true, exists: true }),
      checkIndexExists: async () => true, // All index.md exist
    })

    expect(result.totalNotes).toBe(3)
    expect(result.conformingNotes).toBe(3)
    expect(result.conformanceScore).toBe(100)
    expect(result.violations).toHaveLength(0)
    expect(result.brokenWikilinks).toHaveLength(0)
    expect(result.brokenRepoLinks).toHaveLength(0)
    expect(result.orphanNotes).toHaveLength(0)
    expect(result.missingIndices).toHaveLength(0)
  })

  it('detects violations, broken wikilinks, broken repo links, missing indices, and orphan notes', async () => {
    const notes = [
      { path: 'index', name: 'index', type: 'index' },
      { path: 'domains/auth/session', name: 'auth/session', type: 'domains' },
      { path: 'domains/auth/broken', name: 'auth/broken', type: 'domains' },
      { path: 'specs/isolated', name: 'isolated', type: 'specs' },
    ]

    const contents: Record<string, { frontmatter: Frontmatter; body: string }> = {
      index: {
        frontmatter: { type: 'index' },
        body: 'Root without links',
      },
      'domains/auth/session': {
        frontmatter: {
          type: 'domains',
          timestamp: '2026-09-22', // VIOLATION: bare date!
        },
        body: 'Links to [[non-existent-target]] and [[repo:unknown-repo/src/file.ts]]',
      },
      'domains/auth/broken': {
        frontmatter: {
          type: 'wrong-type', // VIOLATION: type mismatch with path!
        },
        body: 'Content referencing [[domains/auth/session]]',
      },
      'specs/isolated': {
        frontmatter: {
          type: 'specs',
          timestamp: '2026-09-22T00:00:00Z',
        },
        body: 'Completely isolated note with 0 incoming and 0 outgoing links',
      },
    }

    const result = await auditVaultConformance(vaultId, userId, {
      getNotes: async () => notes,
      readNoteContent: async (_, path) => contents[path] ?? null,
      checkRepoFile: async () => ({ accessible: false, exists: false }),
      checkIndexExists: async (_, dir) => {
        // missing index for domains/auth
        return dir !== 'domains/auth'
      },
    })

    expect(result.totalNotes).toBe(4)

    // Violations:
    // 1. domains/auth/session: timestamp bare date
    // 2. domains/auth/broken: type mismatch
    expect(result.violations.some((v) => v.path === 'domains/auth/session')).toBe(true)
    expect(result.violations.some((v) => v.path === 'domains/auth/broken')).toBe(true)

    // Broken links:
    expect(result.brokenWikilinks.some((b) => b.link === 'non-existent-target')).toBe(true)
    expect(result.brokenRepoLinks.some((r) => r.link === 'repo:unknown-repo/src/file.ts')).toBe(true)

    // Missing index for domains/auth
    expect(result.missingIndices).toContain('domains/auth')

    // Orphan note: specs/isolated (0 in, 0 out; index is root bundle file so excluded)
    expect(result.orphanNotes).toContain('specs/isolated')
    expect(result.orphanNotes).not.toContain('index')

    // Root 'index' is the only conforming note here
    expect(result.conformingNotes).toBe(1)
    expect(result.conformanceScore).toBe(25) // 1 / 4 = 25%
  })
})

describe('Path Resolution & Browse Vault progressive disclosure', () => {
  it('correctly resolves hierarchical directories for progressive disclosure', () => {
    const res = resolveNotePath('domains/auth/lifecycle')
    expect(res.fullPath).toBe('domains/auth/lifecycle')
    expect(res.ancestorDirectories).toEqual(['domains/auth', 'domains'])
  })

  it('extracts wikilinks with anchors and aliases cleanly', () => {
    const body = `
    Refer to [[concepts/session-lifecycle|Session Engine]] for details.
    See deep link [[repo:chapters/server/src/mcp/server.ts#L45-L75]] in the codebase.
    Also check [[models/vault#Properties]].
    `
    const links = extractWikilinks(body)
    expect(links).toContain('concepts/session-lifecycle')
    expect(links).toContain('repo:chapters/server/src/mcp/server.ts')
    expect(links).toContain('models/vault')
  })

  it('filters directNotes and computes subdirectories with note counts for browse_vault', () => {
    const dir = 'domains'
    const prefix = `${dir}/`
    const mockNotes = [
      { id: '1', path: 'index', type: 'index', name: 'index' },
      { id: '2', path: 'domains/overview', type: 'domains', name: 'overview' },
      { id: '3', path: 'domains/architecture', type: 'domains', name: 'architecture' },
      { id: '4', path: 'domains/auth/session', type: 'domains', name: 'auth/session' },
      { id: '5', path: 'domains/auth/tokens', type: 'domains', name: 'auth/tokens' },
      { id: '6', path: 'domains/data/schema', type: 'domains', name: 'data/schema' },
      { id: '7', path: 'domains/data/deep/nested', type: 'domains', name: 'data/deep/nested' },
    ]

    const directNotes: typeof mockNotes = []
    const subdirCounts = new Map<string, number>()

    for (const note of mockNotes) {
      if (!note.path.startsWith(prefix)) continue
      const remainder = note.path.slice(prefix.length)
      if (!remainder) continue
      const slashIndex = remainder.indexOf('/')
      if (slashIndex === -1) {
        directNotes.push(note)
      } else {
        const subdir = remainder.slice(0, slashIndex)
        subdirCounts.set(subdir, (subdirCounts.get(subdir) ?? 0) + 1)
      }
    }

    const subdirectories = [...subdirCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name))

    // Direct notes in "domains" should be "domains/overview" and "domains/architecture"
    expect(directNotes.map((n) => n.path)).toEqual(['domains/overview', 'domains/architecture'])

    // Subdirectories: auth (2 notes), data (2 notes)
    expect(subdirectories).toEqual([
      { name: 'auth', count: 2 },
      { name: 'data', count: 2 },
    ])
  })

  it('resolves create_note input from path or type/name equivalently', () => {
    const fromPath = resolveNotePath('domains/auth/session')
    const fromTypeName = resolveNotePath(`${'domains'}/${'auth/session'}`)

    expect(fromPath.fullPath).toBe('domains/auth/session')
    expect(fromTypeName.fullPath).toBe('domains/auth/session')
    expect(fromPath.type).toBe('domains')
    expect(fromPath.name).toBe('auth/session')
  })
})

describe('Code Staleness Drift Detection', () => {
  it('detects hash drift and file deletions between note sources and repository files', () => {
    const repoFiles = new Map<string, string>([
      ['server/src/auth.ts', 'hash-111-current'],
      ['server/src/db.ts', 'hash-222-matching'],
    ])

    const noteSources = [
      // Matching hash - fresh
      {
        noteId: 'n1',
        notePath: 'domains/auth/spec',
        resource: 'repo:chapters/server/src/db.ts',
        expectedHash: 'hash-222-matching',
      },
      // Drifted hash - code modified upstream
      {
        noteId: 'n2',
        notePath: 'domains/auth/session',
        resource: 'repo:chapters/server/src/auth.ts',
        expectedHash: 'hash-111-old',
      },
      // Missing file - deleted in repo
      {
        noteId: 'n3',
        notePath: 'domains/auth/deleted-module',
        resource: 'repo:chapters/server/src/removed.ts',
        expectedHash: 'hash-333-old',
      },
    ]

    const drifts = []
    for (const src of noteSources) {
      const filePath = src.resource.replace(/^repo:[^/]+\//, '').split('#')[0]!
      const currentHash = repoFiles.has(filePath) ? repoFiles.get(filePath)! : null
      if (currentHash !== src.expectedHash) {
        drifts.push({
          noteId: src.noteId,
          notePath: src.notePath,
          resource: src.resource,
          expectedHash: src.expectedHash,
          currentHash,
        })
      }
    }

    expect(drifts).toHaveLength(2)
    expect(drifts[0]).toEqual({
      noteId: 'n2',
      notePath: 'domains/auth/session',
      resource: 'repo:chapters/server/src/auth.ts',
      expectedHash: 'hash-111-old',
      currentHash: 'hash-111-current',
    })
    expect(drifts[1]).toEqual({
      noteId: 'n3',
      notePath: 'domains/auth/deleted-module',
      resource: 'repo:chapters/server/src/removed.ts',
      expectedHash: 'hash-333-old',
      currentHash: null,
    })
  })
})
