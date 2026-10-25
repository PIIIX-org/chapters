import { describe, expect, it } from 'vitest'
import { buildResolutionContext, isResolutionManifest, resolveImportPath } from '../src/repositories/import-resolution.js'

// #466: a pnpm monorepo as a repository's files. Packages resolve by their
// package.json `name`, path aliases by the importing file's tsconfig.
const manifests: Record<string, string> = {
  'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - '!packages/legacy'\n",
  'package.json': JSON.stringify({ name: 'acme', private: true }),
  'apps/web/package.json': JSON.stringify({ name: '@acme/web', dependencies: { '@acme/ui': 'workspace:*', react: '^19.0.0' } }),
  // JSONC, as tsc reads it: comments and trailing commas.
  'apps/web/tsconfig.json': `{
    // Vite app
    "extends": "../../tsconfig.base.json",
    "compilerOptions": {
      "baseUrl": ".", /* paths are relative to it */
      "paths": { "~/*": ["./src/*"], "#config": ["./src/config/index.ts"], },
    },
  }`,
  'apps/docs/package.json': JSON.stringify({ name: '@acme/docs' }),
  // No baseUrl: targets are relative to the tsconfig's own directory (TypeScript 4.1+).
  'apps/docs/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@ui/*': ['../../packages/ui/src/*'] } } }),
  'packages/ui/package.json': JSON.stringify({
    name: '@acme/ui',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './button': './src/button.tsx',
      './icons/*': './src/icons/*.tsx',
      './package.json': './package.json',
    },
  }),
  'packages/utils/package.json': JSON.stringify({ name: '@acme/utils', main: './dist/index.js' }),
  'packages/legacy/package.json': JSON.stringify({ name: '@acme/legacy', main: 'index.js' }),
  // Outside the workspace globs: a fixture named like an npm package is not a workspace package.
  'examples/demo/package.json': JSON.stringify({ name: 'react', main: 'index.js' }),
  'tools/cli/package.json': JSON.stringify({ name: 'acme-cli', imports: { '#internal/*': './src/internal/*.js' } }),
  'broken/package.json': '{ "name": "@acme/broken", ',
  'broken/tsconfig.json': '{ "compilerOptions": ',
}

const sources = [
  'apps/web/src/main.tsx',
  'apps/web/src/lib/format.ts',
  'apps/web/src/config/index.ts',
  'apps/web/src/content/intro.md',
  'apps/docs/src/page.ts',
  'packages/ui/src/index.ts',
  'packages/ui/src/button.tsx',
  'packages/ui/src/icons/check.tsx',
  'packages/utils/src/index.ts',
  'packages/utils/src/strings.ts',
  'packages/legacy/index.js',
  'examples/demo/index.js',
  'tools/cli/src/main.ts',
  'tools/cli/src/internal/log.ts',
]

const known = new Set([...Object.keys(manifests), ...sources])
const context = buildResolutionContext(Object.entries(manifests).map(([path, content]) => ({ path, content })))
const web = 'apps/web/src/main.tsx'
const resolve = (source: string, specifier: string) => resolveImportPath(source, specifier, known, context)

describe('isResolutionManifest', () => {
  it('names package.json, pnpm-workspace.yaml and tsconfig/jsconfig files at any depth', () => {
    for (const path of ['package.json', 'apps/web/package.json', 'pnpm-workspace.yaml', 'tsconfig.json', 'apps/web/tsconfig.app.json', 'jsconfig.json']) {
      expect(isResolutionManifest(path), path).toBe(true)
    }
    for (const path of ['package-lock.json', 'src/package.json.ts', 'tsconfig.ts', 'apps/web/src/main.tsx']) {
      expect(isResolutionManifest(path), path).toBe(false)
    }
  })
})

describe('workspace packages (#466)', () => {
  it('resolves @acme/ui to its source entry: the built `exports` target mapped back to src', () => {
    expect(resolve(web, '@acme/ui')).toBe('packages/ui/src/index.ts')
  })

  it('resolves @acme/ui/button through its `exports` subpath', () => {
    expect(resolve(web, '@acme/ui/button')).toBe('packages/ui/src/button.tsx')
  })

  it('resolves an `exports` pattern subpath', () => {
    expect(resolve(web, '@acme/ui/icons/check')).toBe('packages/ui/src/icons/check.tsx')
  })

  it('resolves a package without `exports` by `main`, and a subpath under the package or its src', () => {
    expect(resolve(web, '@acme/utils')).toBe('packages/utils/src/index.ts')
    expect(resolve(web, '@acme/utils/strings')).toBe('packages/utils/src/strings.ts')
    expect(resolve(web, '@acme/utils/strings.js')).toBe('packages/utils/src/strings.ts')
  })

  it('resolves from any file in the repository, including another package', () => {
    expect(resolve('packages/ui/src/button.tsx', '@acme/utils')).toBe('packages/utils/src/index.ts')
  })

  it('leaves external packages unresolved: no workspace package has that name', () => {
    expect(resolve(web, 'react')).toBeNull()
    expect(resolve(web, 'react-dom/client')).toBeNull()
    expect(resolve(web, '@tanstack/react-query')).toBeNull()
    expect(resolve(web, '@acme/unknown')).toBeNull()
    expect(resolve(web, 'node:fs')).toBeNull()
  })

  it('counts only the package.json files the workspace globs select, negations included', () => {
    expect(resolve(web, '@acme/legacy')).toBeNull()
  })

  it('returns null for a subpath that is in no file', () => {
    expect(resolve(web, '@acme/ui/missing')).toBeNull()
  })

  it('ignores a manifest that does not parse', () => {
    expect(resolve(web, '@acme/broken')).toBeNull()
  })

  it('counts every named package.json when the repository declares no workspace', () => {
    const files = [
      { path: 'package.json', content: JSON.stringify({ name: 'app' }) },
      { path: 'libs/core/package.json', content: JSON.stringify({ name: 'core', exports: './lib/main.js' }) },
    ]
    const paths = new Set(['src/app.ts', 'libs/core/lib/main.js'])
    expect(resolveImportPath('src/app.ts', 'core', paths, buildResolutionContext(files))).toBe('libs/core/lib/main.js')
  })

  it('reads npm/yarn `workspaces` from package.json, as an array or as `{ packages }`', () => {
    const paths = new Set(['src/app.ts', 'pkgs/a/index.ts', 'pkgs/b/index.ts', 'other/c/index.ts'])
    const pkgs = [
      { path: 'pkgs/a/package.json', content: JSON.stringify({ name: 'a' }) },
      { path: 'pkgs/b/package.json', content: JSON.stringify({ name: 'b' }) },
      { path: 'other/c/package.json', content: JSON.stringify({ name: 'c' }) },
    ]
    for (const workspaces of [['pkgs/*'], { packages: ['pkgs/**'] }]) {
      const ctx = buildResolutionContext([{ path: 'package.json', content: JSON.stringify({ name: 'root', workspaces }) }, ...pkgs])
      expect(resolveImportPath('src/app.ts', 'a', paths, ctx)).toBe('pkgs/a/index.ts')
      expect(resolveImportPath('src/app.ts', 'b', paths, ctx)).toBe('pkgs/b/index.ts')
      expect(resolveImportPath('src/app.ts', 'c', paths, ctx)).toBeNull()
    }
  })

  it('keeps the query suffix out of package resolution', () => {
    expect(resolve(web, '@acme/ui/button?url')).toBe('packages/ui/src/button.tsx')
  })

  it('without a context, no package resolves', () => {
    expect(resolveImportPath(web, '@acme/ui', known)).toBeNull()
  })
})

describe('package.json `imports` (#x subpath imports)', () => {
  it('resolves #x by the nearest package.json `imports`, a built .js target mapped to its TS source', () => {
    expect(resolve('tools/cli/src/main.ts', '#internal/log')).toBe('tools/cli/src/internal/log.ts')
    expect(resolve(web, '#internal/log')).toBeNull()
  })
})

describe('tsconfig/jsconfig `paths` and `baseUrl` (#466)', () => {
  it('resolves ~/* through the importing file’s tsconfig paths', () => {
    expect(resolve(web, '~/lib/format')).toBe('apps/web/src/lib/format.ts')
    expect(resolve('apps/web/src/lib/format.ts', '~/config')).toBe('apps/web/src/config/index.ts')
    expect(resolve(web, '~/content/intro.md?raw')).toBe('apps/web/src/content/intro.md')
  })

  it('resolves an exact paths entry', () => {
    expect(resolve(web, '#config')).toBe('apps/web/src/config/index.ts')
  })

  it('resolves a bare specifier against baseUrl', () => {
    expect(resolve(web, 'src/lib/format')).toBe('apps/web/src/lib/format.ts')
  })

  it('applies a tsconfig only to the files under its directory', () => {
    expect(resolve('apps/docs/src/page.ts', '~/lib/format')).toBeNull()
    expect(resolve('packages/ui/src/button.tsx', '~/lib/format')).toBeNull()
  })

  it('resolves paths relative to the tsconfig’s directory when it has no baseUrl', () => {
    expect(resolve('apps/docs/src/page.ts', '@ui/button')).toBe('packages/ui/src/button.tsx')
  })

  it('reads jsconfig.json the same way', () => {
    const ctx = buildResolutionContext([
      { path: 'site/jsconfig.json', content: JSON.stringify({ compilerOptions: { baseUrl: 'src', paths: { '@lib/*': ['lib/*'] } } }) },
    ])
    const paths = new Set(['site/src/lib/date.js', 'site/src/app.js'])
    expect(resolveImportPath('site/src/app.js', '@lib/date', paths, ctx)).toBe('site/src/lib/date.js')
  })

  // #987 review: a declared alias that matches but finds no file stays unresolved.
  it('does not fall back to the @/ convention when a declared @/* alias matches but finds no file', () => {
    const ctx = buildResolutionContext([
      { path: 'web/tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '@/*': ['./app/*'] } } }) },
    ])
    const paths = new Set(['web/src/page.ts', 'web/src/lib/db.ts', 'web/app/lib/api.ts'])
    expect(resolveImportPath('web/src/page.ts', '@/lib/api', paths, ctx)).toBe('web/app/lib/api.ts')
    expect(resolveImportPath('web/src/page.ts', '@/lib/db', paths, ctx)).toBeNull()
  })

  // #987 review: the directory's own tsconfig.json/jsconfig.json is read before its other configs, whatever else the repository has.
  it('reads tsconfig.json before a same-directory jsconfig.build.json, with configs in other directories', () => {
    const ctx = buildResolutionContext([
      { path: 'a/jsconfig.build.json', content: JSON.stringify({ compilerOptions: { paths: { '~/*': ['./build-src/*'] } } }) },
      { path: 'a/lib/tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '#lib': ['./x.ts'] } } }) },
      { path: 'a/tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '~/*': ['./src/*'] } } }) },
    ])
    const paths = new Set(['a/main.ts', 'a/src/util.ts', 'a/build-src/util.ts'])
    expect(resolveImportPath('a/main.ts', '~/util', paths, ctx)).toBe('a/src/util.ts')
  })
})

// #987 review: tsconfig paths, baseUrl, package.json `imports` and workspace
// package names are JavaScript module resolution; a Python or Go import never uses them.
describe('manifests apply to JS/TS importers only', () => {
  const ctx = buildResolutionContext([
    { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['./src/*'] } } }) },
    { path: 'packages/utils/package.json', content: JSON.stringify({ name: 'utils' }) },
  ])
  const paths = new Set(['config.ts', 'server/index.ts', 'src/a.ts', 'packages/utils/src/index.ts', 'scripts/train.py', 'cmd/main.go', 'app.ts'])

  it('leaves a Python or Go import that names a baseUrl path or a workspace package unresolved', () => {
    for (const source of ['scripts/train.py', 'cmd/main.go']) {
      expect(resolveImportPath(source, 'config', paths, ctx), source).toBeNull()
      expect(resolveImportPath(source, 'server', paths, ctx), source).toBeNull()
      expect(resolveImportPath(source, 'utils', paths, ctx), source).toBeNull()
      expect(resolveImportPath(source, '~/a', paths, ctx), source).toBeNull()
    }
  })

  it('still resolves the same specifiers from a JS/TS importer', () => {
    expect(resolveImportPath('app.ts', 'config', paths, ctx)).toBe('config.ts')
    expect(resolveImportPath('app.ts', 'utils', paths, ctx)).toBe('packages/utils/src/index.ts')
    expect(resolveImportPath('app.ts', '~/a', paths, ctx)).toBe('src/a.ts')
  })
})
