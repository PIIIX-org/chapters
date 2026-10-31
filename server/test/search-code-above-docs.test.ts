// #457: rank code above docs and plans for code-shaped queries.
// Code-shaped queries (identifiers, extensions, path separators, code keywords like function/class)
// apply a small bounded boost so code files outrank documentation among otherwise-comparable hits.
// The boost must be small enough that documentation answering a doc question that mentions an
// identifier still wins. Prose queries remain untouched.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { isCodeShaped, searchNotes } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

let repoId: string

afterEach(() => {
  vi.restoreAllMocks()
})

beforeAll(async () => {
  const user = await createActiveUser()
  const [r] = await db.insert(repositories).values({ name: 'code-above-docs-repo', ownerId: user.id, ingestionMethod: 'agent_push' }).returning()
  repoId = r!.id

  const files = [
    // 1. Code file implementing parseConfig
    {
      path: 'src/config/parser.ts',
      content: 'export function parseConfig(input: string): Record<string, string> {\n  return {}\n}\n',
    },
    // 2. Documentation file mentioning function parseConfig multiple times, giving it higher density
    // On base, docs/architecture/config-guide.md beats src/config/parser.ts (0.03278 vs 0.03225)
    {
      path: 'docs/architecture/config-guide.md',
      content:
        '# Function parseConfig Guide\n\nThe function parseConfig is documented here. The function parseConfig handles deployment and architecture.\n',
    },
    // 3. Overview doc for prose query test
    {
      path: 'docs/overview.md',
      content: '# Overview\n\nSystem overview documentation and architecture.\n',
    },
  ]

  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await flushExtraction()
}, 180_000)

describe('code ranks above docs for code-shaped queries (#457)', () => {
  it('code-shaped query ranks code above docs for otherwise-comparable hits', async () => {
    // Code-shaped query using keyword 'function' and identifier 'parseConfig':
    // On base without #457: docs/architecture/config-guide.md has higher keyword density and sorts
    // first alphabetically, scoring 0.03278 vs 0.03225 for src/config/parser.ts.
    // With #457: query is code-shaped, so src/config/parser.ts receives CODE_BOOST and ranks first.
    const res = await searchNotes({ vaultIds: [], repositoryIds: [repoId] }, 'function parseConfig', 10)
    expect(res.results.length).toBeGreaterThan(0)
    expect(res.results[0]!.path).toBe('src/config/parser.ts')
  })

  it('doc question that mentions an identifier still lets the doc win', async () => {
    // Query is asking for documentation: 'architecture and deployment guide for parseConfig'
    // docs/architecture/config-guide.md is the real answer and matches many more query words
    const res = await searchNotes(
      { vaultIds: [], repositoryIds: [repoId] },
      'architecture and deployment guide for parseConfig',
      10,
    )
    expect(res.results.length).toBeGreaterThan(0)
    // The doc that is the real answer is NOT hidden by the small code boost
    expect(res.results[0]!.path).toBe('docs/architecture/config-guide.md')
  })

  it('prose query without code features leaves ranking untouched', async () => {
    const res = await searchNotes({ vaultIds: [], repositoryIds: [repoId] }, 'System overview documentation', 10)
    expect(res.results.length).toBeGreaterThan(0)
    expect(res.results[0]!.path).toBe('docs/overview.md')
  })

  it('isCodeShaped rejects prose queries with tech brands, slashes, parens, and rationale questions', () => {
    // False positive cases flagged by review:
    expect(isCodeShaped('and/or condition handling')).toBe(false)
    expect(isCodeShaped('installing via curl/wget on Linux')).toBe(false)
    expect(isCodeShaped('differences between Node/V8 runtime')).toBe(false)
    expect(isCodeShaped('How do you compile to WebAssembly')).toBe(false)
    expect(isCodeShaped('Where are the issues on GitHub')).toBe(false)
    expect(isCodeShaped('REST and GraphQL APIs overview')).toBe(false)
    expect(isCodeShaped('Why does the codebase forbid unwrap() in shipped code')).toBe(false)
    expect(isCodeShaped('Which semantic pattern routes to the visual type')).toBe(false)
    expect(isCodeShaped('How to export the diagram to SVG')).toBe(false)
    expect(
      isCodeShaped(
        'Why do SessionDB and ContentStore allow multiple writer processes on the same database file instead of using a lock file?',
      ),
    ).toBe(false)
  })

  it('isCodeShaped accepts genuine code queries', () => {
    expect(isCodeShaped('where is src/config/parser.ts')).toBe(true)
    expect(isCodeShaped('function parseConfig')).toBe(true)
    expect(isCodeShaped('export class HopperRequestQueue')).toBe(true)
    expect(isCodeShaped('def parse_frontmatter')).toBe(true)
    expect(isCodeShaped('crates/engine/src/guard.rs')).toBe(true)
  })
})
