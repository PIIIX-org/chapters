// #1008: a repository's import rows are a function of its files, not of the
// order they arrived in (ADR-004 §1.3, #473). A sync that creates or deletes
// files re-resolves the imports those paths can change: an import pushed
// before its target, one a higher-precedence file now wins, one whose target
// is gone.
import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, repositoryFileImports, repositoryFiles } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { backfillUnresolvedImports, flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser } from './helpers.js'

/** One repository of the resolution rules an import can take: relative with index and precedence, tsconfig paths, workspace packages, Rust, Java. */
const FILES: Record<string, string> = {
  'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
  'package.json': JSON.stringify({ name: 'acme', private: true }),
  'apps/web/package.json': JSON.stringify({ name: '@acme/web' }),
  'apps/web/tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["./src/*"] } } }\n',
  'apps/web/src/main.tsx': [
    "import { Button } from '@acme/ui/button'",
    "import { theme } from '@acme/ui'",
    "import { format } from '~/lib/format'",
    "import { foo } from './foo'",
    "import { upload } from './upload.js'",
    "import { useState } from 'react'",
    'export const App = () => <Button theme={theme}>{format(foo, upload)}</Button>',
    '',
  ].join('\n'),
  'apps/web/src/lib/format.ts': 'export function format(...s: unknown[]) { return String(s) }\n',
  'apps/web/src/foo/index.ts': 'export const foo = 1\n',
  'apps/web/src/foo.ts': 'export const foo = 2\n',
  'apps/web/src/upload.ts': 'export function upload() {}\n',
  'packages/ui/package.json': JSON.stringify({
    name: '@acme/ui',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './button': './src/button.tsx' },
  }),
  'packages/ui/src/index.ts': "export const theme = 'light'\n",
  'packages/ui/src/button.tsx': 'export function Button() { return null }\n',
  'crates/core/src/lib.rs': 'mod store;\nuse crate::store::Store;\n',
  'crates/core/src/store/mod.rs': 'pub struct Store;\n',
  'app/src/main/java/com/example/store/Store.java': 'package com.example.store;\nimport com.example.index.Entry;\npublic class Store {}\n',
  'app/src/main/java/com/example/index/Entry.java': 'package com.example.index;\npublic class Entry {}\n',
}

/** Files that win over FILES' targets while they exist: a literal `foo` before `foo.ts`, a package's built `dist/index.js` before its `src/index.ts`. */
const EXTRA: Record<string, string> = {
  'apps/web/src/foo': 'export const foo = 3\n',
  'packages/ui/dist/index.js': "export const theme = 'dark'\n",
}

async function makeRepo(name: string) {
  const owner = await createActiveUser()
  const [repo] = await db.insert(repositories).values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
  return repo!
}

/** One sync that leaves the repository holding exactly `paths` of FILES (pushing them all; unchanged ones are skipped). */
async function syncTo(repositoryId: string, paths: string[]) {
  await syncRepositoryFiles(
    repositoryId,
    paths.map((path) => ({ path, content: FILES[path] ?? EXTRA[path]! })),
    paths,
  )
  await flushExtraction()
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

/**
 * Every import row of the repository, whole, with the file ids replaced by
 * their paths and the repository-id prefix of each lookup key (asserted)
 * dropped, so rows of two repositories compare; sorted.
 */
async function allImportRows(repositoryId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT to_jsonb(i) - 'source_file_id' - 'resolved_target_file_id'
      || jsonb_build_object('source', f.path, 'resolved', t.path) AS "row"
    FROM ${repositoryFileImports} i
    JOIN ${repositoryFiles} f ON f.id = i.source_file_id
    LEFT JOIN ${repositoryFiles} t ON t.id = i.resolved_target_file_id
    WHERE f.repository_id = ${repositoryId}`)) as unknown as Array<{ row: { lookup_keys?: string[] | null } }>
  const prefix = `${repositoryId}:`
  for (const { row } of rows) {
    if (!row.lookup_keys) continue
    expect(row.lookup_keys.every((k) => k.startsWith(prefix)), JSON.stringify(row)).toBe(true)
    row.lookup_keys = row.lookup_keys.map((k) => k.slice(prefix.length))
  }
  return rows.map((r) => JSON.stringify(r.row)).sort()
}

const ALL = Object.keys(FILES)
const without = (...paths: string[]) => ALL.filter((p) => !paths.includes(p))

describe('import rows do not depend on the order files arrive in (#1008)', () => {
  it('an import pushed before the file it imports resolves once that file arrives (the issue repro)', async () => {
    const repo = await makeRepo('imports-later-target')
    const retry = { path: 'src/retry.ts', content: "import { upload } from './upload'\nexport const retry = () => upload()\n" }
    const upload = { path: 'src/upload.ts', content: 'export function upload() {}\n' }
    await syncRepositoryFiles(repo.id, [retry], [retry.path])
    await flushExtraction()
    expect(await importsOf(repo.id, 'src/retry.ts')).toEqual({ './upload': null })

    await syncRepositoryFiles(repo.id, [upload], [retry.path, upload.path])
    await flushExtraction()
    expect(await importsOf(repo.id, 'src/retry.ts')).toEqual({ './upload': 'src/upload.ts' })
  })

  it('a resolved import moves to a higher-precedence file that arrives later (`foo/index.ts`, then `foo.ts`)', async () => {
    const repo = await makeRepo('imports-precedence')
    await syncTo(repo.id, without('apps/web/src/foo.ts'))
    expect((await importsOf(repo.id, 'apps/web/src/main.tsx'))['./foo']).toBe('apps/web/src/foo/index.ts')

    await syncTo(repo.id, ALL)
    expect((await importsOf(repo.id, 'apps/web/src/main.tsx'))['./foo']).toBe('apps/web/src/foo.ts')
  })

  it('an import whose target is deleted falls back to the next candidate, then stays as an unresolved row', async () => {
    const repo = await makeRepo('imports-deleted-target')
    await syncTo(repo.id, ALL)
    expect(await importsOf(repo.id, 'apps/web/src/main.tsx')).toMatchObject({ './foo': 'apps/web/src/foo.ts', './upload.js': 'apps/web/src/upload.ts' })

    await syncTo(repo.id, without('apps/web/src/foo.ts', 'apps/web/src/upload.ts'))
    expect(await importsOf(repo.id, 'apps/web/src/main.tsx')).toMatchObject({ './foo': 'apps/web/src/foo/index.ts', './upload.js': null })

    await syncTo(repo.id, without('apps/web/src/foo.ts', 'apps/web/src/upload.ts', 'apps/web/src/foo/index.ts'))
    expect(await importsOf(repo.id, 'apps/web/src/main.tsx')).toMatchObject({ './foo': null, './upload.js': null })
  })

  it('tsconfig-path, workspace-package, Rust and Java imports resolve once their targets arrive', async () => {
    const repo = await makeRepo('imports-later-targets-by-rule')
    const targets = [
      'apps/web/src/lib/format.ts',
      'packages/ui/src/index.ts',
      'packages/ui/src/button.tsx',
      'crates/core/src/store/mod.rs',
      'app/src/main/java/com/example/index/Entry.java',
    ]
    await syncTo(repo.id, without(...targets))
    expect(await importsOf(repo.id, 'apps/web/src/main.tsx')).toMatchObject({ '~/lib/format': null, '@acme/ui': null, '@acme/ui/button': null })

    await syncTo(repo.id, ALL)
    expect(await importsOf(repo.id, 'apps/web/src/main.tsx')).toEqual({
      '@acme/ui/button': 'packages/ui/src/button.tsx',
      '@acme/ui': 'packages/ui/src/index.ts',
      '~/lib/format': 'apps/web/src/lib/format.ts',
      './foo': 'apps/web/src/foo.ts',
      './upload.js': 'apps/web/src/upload.ts',
      react: null,
    })
    expect(await importsOf(repo.id, 'crates/core/src/lib.rs')).toEqual({ store: 'crates/core/src/store/mod.rs', 'crate::store::Store': 'crates/core/src/store/mod.rs' })
    expect(await importsOf(repo.id, 'app/src/main/java/com/example/store/Store.java')).toEqual({
      'com.example.index.Entry': 'app/src/main/java/com/example/index/Entry.java',
    })
  })

  it('two pushes in either order, or one file at a time, give the import rows of one push', async () => {
    const one = await makeRepo('imports-one-push')
    await syncTo(one.id, ALL)
    const expected = await allImportRows(one.id)
    expect(expected).toHaveLength(9)

    const half = ALL.filter((_, i) => i % 2 === 0)
    const other = ALL.filter((_, i) => i % 2 === 1)
    const orders: Array<[string, string[][]]> = [
      ['even files, then the rest', [half, ALL]],
      ['odd files, then the rest', [other, ALL]],
      ['one at a time', ALL.map((_, i) => ALL.slice(0, i + 1))],
      ['one at a time, in reverse', ALL.map((_, i) => ALL.slice(ALL.length - 1 - i))],
      ['everything with extra files, then without them', [[...ALL, ...Object.keys(EXTRA)], ALL]],
    ]
    for (const [name, steps] of orders) {
      const repo = await makeRepo(`imports-${name.replaceAll(/\W+/g, '-')}`)
      for (const paths of steps) await syncTo(repo.id, paths)
      expect(await allImportRows(repo.id), name).toEqual(expected)
    }
  })

  it('rows written before their lookup keys existed get them at boot, then follow the files that arrive', async () => {
    const repo = await makeRepo('imports-keys-backfill')
    await syncTo(repo.id, without('apps/web/src/foo.ts'))
    await db.execute(sql`
      UPDATE ${repositoryFileImports} i SET lookup_keys = NULL
      FROM ${repositoryFiles} f WHERE f.id = i.source_file_id AND f.repository_id = ${repo.id}`)

    await backfillUnresolvedImports()
    const unkeyed = (await db.execute(sql`
      SELECT count(*)::int AS n FROM ${repositoryFileImports} i JOIN ${repositoryFiles} f ON f.id = i.source_file_id
      WHERE f.repository_id = ${repo.id} AND i.lookup_keys IS NULL`)) as unknown as Array<{ n: number }>
    expect(unkeyed[0]!.n).toBe(0)

    await syncTo(repo.id, ALL)
    expect((await importsOf(repo.id, 'apps/web/src/main.tsx'))['./foo']).toBe('apps/web/src/foo.ts')
  })
})
