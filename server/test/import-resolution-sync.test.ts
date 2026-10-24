// #466: a repository's import rows resolve workspace packages, tsconfig path
// aliases and `?raw` specifiers from the manifests indexed with it, capture
// re-exports, `import()` and `require()`, and follow a manifest change.
import { describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, repositoryFileImports, repositoryFiles } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { backfillUnresolvedImports, flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser } from './helpers.js'

const FILES: Record<string, string> = {
  'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
  'package.json': JSON.stringify({ name: 'acme', private: true }),
  'apps/web/package.json': JSON.stringify({ name: '@acme/web', dependencies: { '@acme/ui': 'workspace:*', react: '^19.0.0' } }),
  'apps/web/tsconfig.json': '{\n  // Vite app\n  "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["./src/*"] } },\n}\n',
  'apps/web/src/main.tsx': [
    "import { Button } from '@acme/ui/button'",
    "import { theme } from '@acme/ui'",
    "import { format } from '~/lib/format'",
    "import intro from './content/intro.md?raw'",
    "import { useState } from 'react'",
    "export { routes } from './routes'",
    "export * from './exported'",
    "const Settings = lazy(() => import('./pages/settings'))",
    "const legacy = require('./legacy.cjs')",
    "import { kit } from '@acme/kit'",
    'export const App = () => <Button theme={theme}>{format(intro)}</Button>',
    '',
  ].join('\n'),
  'apps/web/src/lib/format.ts': 'export function format(s: string) { return s.trim() }\n',
  'apps/web/src/content/intro.md': '# Intro\n',
  'apps/web/src/routes.ts': 'export const routes = []\n',
  'apps/web/src/exported.ts': 'export const exported = 1\n',
  'apps/web/src/pages/settings.tsx': 'export default function Settings() { return null }\n',
  'apps/web/src/legacy.cjs': 'module.exports = {}\n',
  'packages/ui/package.json': JSON.stringify({
    name: '@acme/ui',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './button': './src/button.tsx' },
  }),
  'packages/ui/src/index.ts': "export const theme = 'light'\n",
  'packages/ui/src/button.tsx': 'export function Button() { return null }\n',
}

async function makeRepo(name: string) {
  const owner = await createActiveUser()
  const [repo] = await db.insert(repositories).values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
  return repo!
}

/** The import rows of `path`: specifier → the path of the file it resolves to, or null. */
async function importsOf(repositoryId: string, path: string): Promise<Record<string, string | null>> {
  const rows = (await db.execute(sql`
    SELECT i.target_path AS "target", t.path AS "resolved"
    FROM ${repositoryFileImports} i
    JOIN ${repositoryFiles} f ON f.id = i.source_file_id
    LEFT JOIN ${repositoryFiles} t ON t.id = i.resolved_target_file_id
    WHERE f.repository_id = ${repositoryId} AND f.path = ${path}`)) as unknown as Array<{ target: string; resolved: string | null }>
  return Object.fromEntries(rows.map((r) => [r.target, r.resolved]))
}

async function syncAll(repositoryId: string, files: Record<string, string>) {
  await syncRepositoryFiles(
    repositoryId,
    Object.entries(files).map(([path, content]) => ({ path, content })),
    Object.keys(files),
  )
  await flushExtraction()
}

const RESOLVED = {
  '@acme/ui/button': 'packages/ui/src/button.tsx',
  '@acme/ui': 'packages/ui/src/index.ts',
  '~/lib/format': 'apps/web/src/lib/format.ts',
  './content/intro.md?raw': 'apps/web/src/content/intro.md',
  react: null,
  './routes': 'apps/web/src/routes.ts',
  './exported': 'apps/web/src/exported.ts',
  './pages/settings': 'apps/web/src/pages/settings.tsx',
  './legacy.cjs': 'apps/web/src/legacy.cjs',
  '@acme/kit': null,
}

describe('import resolution in a pnpm monorepo (#466)', () => {
  it('resolves workspace packages, tsconfig paths and ?raw; captures re-exports, import() and require(); react stays external', async () => {
    const repo = await makeRepo('imports-monorepo')
    await syncAll(repo.id, FILES)
    expect(await importsOf(repo.id, 'apps/web/src/main.tsx')).toEqual(RESOLVED)
  })

  it('re-resolves the repository’s imports when a package.json `name` changes, without the importer changing', async () => {
    const repo = await makeRepo('imports-rename')
    await syncAll(repo.id, FILES)
    const renamed = {
      ...FILES,
      'packages/ui/package.json': FILES['packages/ui/package.json']!.replace('"@acme/ui"', '"@acme/kit"'),
    }
    await syncRepositoryFiles(repo.id, [{ path: 'packages/ui/package.json', content: renamed['packages/ui/package.json']! }], Object.keys(renamed))
    await flushExtraction()

    expect(await importsOf(repo.id, 'apps/web/src/main.tsx')).toEqual({
      ...RESOLVED,
      '@acme/ui/button': null,
      '@acme/ui': null,
      '@acme/kit': 'packages/ui/src/index.ts',
    })
  })

  it('re-resolves when a tsconfig is deleted: its aliases no longer resolve', async () => {
    const repo = await makeRepo('imports-tsconfig-deleted')
    await syncAll(repo.id, FILES)
    const remaining = Object.keys(FILES).filter((p) => p !== 'apps/web/tsconfig.json')
    await syncRepositoryFiles(repo.id, [], remaining)
    await flushExtraction()

    expect((await importsOf(repo.id, 'apps/web/src/main.tsx'))['~/lib/format']).toBeNull()
  })

  it('the boot backfill resolves workspace packages too', async () => {
    const repo = await makeRepo('imports-backfill-packages')
    await syncAll(repo.id, FILES)
    const [main] = await db
      .select()
      .from(repositoryFiles)
      .where(and(eq(repositoryFiles.repositoryId, repo.id), eq(repositoryFiles.path, 'apps/web/src/main.tsx')))
    // Rows an older resolver left without a target.
    await db.update(repositoryFileImports).set({ resolvedTargetFileId: null }).where(eq(repositoryFileImports.sourceFileId, main!.id))

    expect(await backfillUnresolvedImports()).toBeGreaterThanOrEqual(8)
    expect(await importsOf(repo.id, 'apps/web/src/main.tsx')).toEqual(RESOLVED)
  })
})
