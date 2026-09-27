import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { notifications, repositories } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { checkCodeStaleness } from '../src/notes/staleness.js'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

async function makeTestRepo(name = 'drift-repo') {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning()
  return { repo: repo!, owner }
}

describe('checkCodeStaleness & drift detection', () => {
  it('detects hash mismatch and deleted files in frontmatter sources', async () => {
    const app = await buildApp()
    await app.ready()
    const { repo, owner } = await makeTestRepo('calc-repo')
    const cookie = await loginCookie(app, owner.email)

    await syncRepositoryFiles(
      repo.id,
      [{ path: 'src/calc.ts', content: 'export const version = 2' }],
      ['src/calc.ts'],
    )

    const vault = (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie },
        body: { name: 'calc-vault' },
      })
    ).json() as { id: string }

    // Note 1: Has outdated hash
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vault.id}/notes`,
      headers: { cookie },
      body: {
        type: 'docs',
        name: 'calc-spec',
        frontmatter: {
          sources: [
            {
              resource: `repo:${repo.name}/src/calc.ts`,
              hash: 'sha256-outdatedhash0000000000000000000000000000000000000000000000000000',
            },
          ],
        },
        body: 'Calculator spec documentation.',
      },
    })

    // Note 2: References a non-existent/deleted file
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vault.id}/notes`,
      headers: { cookie },
      body: {
        type: 'docs',
        name: 'old-module',
        frontmatter: {
          sources: [
            {
              resource: `repo:${repo.name}/src/legacy.ts`,
              hash: 'sha256-legacyhash',
            },
          ],
        },
        body: 'Legacy module documentation.',
      },
    })

    const drifts = await checkCodeStaleness(repo.id)
    expect(drifts.length).toBe(2)

    const hashMismatch = drifts.find((d) => d.kind === 'hash_mismatch')
    expect(hashMismatch).toBeDefined()
    expect(hashMismatch?.notePath).toBe('docs/calc-spec')
    expect(hashMismatch?.resource).toBe(`repo:${repo.name}/src/calc.ts`)

    const deletedFile = drifts.find((d) => d.kind === 'deleted_file')
    expect(deletedFile).toBeDefined()
    expect(deletedFile?.notePath).toBe('docs/old-module')

    // Verify in-app notification was emitted
    const notifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, owner.id))
    expect(notifs.some((n) => n.type === 'code_drift_detected')).toBe(true)

    await app.close()
  })

  it('detects missing files and missing symbols referenced in note wikilinks', async () => {
    const app = await buildApp()
    await app.ready()
    const { repo, owner } = await makeTestRepo('symbol-repo')
    const cookie = await loginCookie(app, owner.email)

    // Code with symbol "add" but not "multiply"
    await syncRepositoryFiles(
      repo.id,
      [{ path: 'src/math.ts', content: 'export function add(a: number, b: number) { return a + b }' }],
      ['src/math.ts'],
    )
    await flushExtraction()

    const vault = (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie },
        body: { name: 'symbol-vault' },
      })
    ).json() as { id: string }

    // Note references both existing symbol, missing symbol, and missing file
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vault.id}/notes`,
      headers: { cookie },
      body: {
        type: 'docs',
        name: 'math-guide',
        body: `
# Math Guide
- Existing symbol: [[repo:symbol-repo/src/math.ts#add]]
- Missing symbol: [[repo:symbol-repo/src/math.ts#multiply]]
- Deleted file: [[repo:symbol-repo/src/missing.ts]]
`,
      },
    })

    const drifts = await checkCodeStaleness(repo.id)
    expect(drifts.some((d) => d.kind === 'missing_symbol' && d.resource.includes('#multiply'))).toBe(true)
    expect(drifts.some((d) => d.kind === 'deleted_file' && d.resource.includes('missing.ts'))).toBe(true)
    // The valid symbol #add should NOT be reported as drift
    expect(drifts.some((d) => d.resource.includes('#add'))).toBe(false)

    await app.close()
  })

  it('GET /api/repositories/:id/drift returns drift details to authorized callers and 404 to unauthorized', async () => {
    const app = await buildApp()
    await app.ready()
    const { repo, owner } = await makeTestRepo('api-drift-repo')
    const cookie = await loginCookie(app, owner.email)

    const otherUser = await createActiveUser()
    const otherCookie = await loginCookie(app, otherUser.email)

    const resAuth = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repo.id}/drift`,
      headers: { cookie },
    })
    expect(resAuth.statusCode).toBe(200)
    const jsonAuth = resAuth.json() as { repositoryId: string; drifts: unknown[] }
    expect(jsonAuth.repositoryId).toBe(repo.id)
    expect(Array.isArray(jsonAuth.drifts)).toBe(true)

    const resUnauth = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repo.id}/drift`,
      headers: { cookie: otherCookie },
    })
    expect(resUnauth.statusCode).toBe(404)

    await app.close()
  })
})
