import { describe, expect, it } from 'vitest'
import { resolveImportPath } from '../src/repositories/import-resolution.js'

// Repository-relative paths, exactly as extraction-queue.ts builds `knownPaths`
// (every repositoryFiles.path of the repository).
const known = new Set([
  'server/src/db/client.ts',
  'server/src/repositories/extraction-queue.ts',
  'server/src/repositories/import-resolution.ts',
  'server/src/graph/index.ts',
  'client/src/App.tsx',
  'client/src/router.tsx',
  'client/src/lib/utils.ts',
  'client/src/lib/api.ts',
  'client/src/components/ui/button.tsx',
  'client/src/components/ui/button-variants.ts',
  'client/src/content/intro.md',
  'client/src/assets/logo.svg',
  'client/src/workers/parse.ts',
  'client/src/components/ui/index.ts',
  'client/src/components/graph/GraphCanvas.tsx',
  'client/src/pages/vault/index.tsx',
  'apps/web/src/lib/utils.ts',
  'apps/web/src/pages/home.tsx',
  'scripts/build.mjs',
  'scripts/util.mjs',
  'scripts/legacy.cjs',
  'tools/gen.mts',
  'tools/load.mts',
  'tools/compat.cts',
  'vendor/plain.js',
  'vendor/app.js',
  'dual/thing.js',
  'dual/thing.ts',
  'dual/main.ts',
  'esm/lib/index.mts',
  'esm/both.mts',
  'esm/both.mjs',
  'cjs/lib/index.cjs',
])

describe('resolveImportPath', () => {
  describe('regression guards (already resolve today)', () => {
    it('resolves an extensionless relative import to .ts', () => {
      expect(resolveImportPath('client/src/App.tsx', './lib/api', known)).toBe('client/src/lib/api.ts')
    })

    it('resolves an extensionless relative import to .tsx', () => {
      expect(resolveImportPath('client/src/App.tsx', './router', known)).toBe('client/src/router.tsx')
    })

    it('resolves a directory import to its index.ts', () => {
      expect(resolveImportPath('server/src/repositories/extraction-queue.ts', '../graph', known)).toBe(
        'server/src/graph/index.ts',
      )
    })

    it('resolves a directory import to its index.tsx', () => {
      expect(resolveImportPath('client/src/App.tsx', './pages/vault', known)).toBe('client/src/pages/vault/index.tsx')
    })

    it('resolves a .js specifier to a real .js file', () => {
      expect(resolveImportPath('vendor/app.js', './plain.js', known)).toBe('vendor/plain.js')
    })

    it('resolves a .mjs specifier to a real .mjs file', () => {
      expect(resolveImportPath('scripts/build.mjs', './util.mjs', known)).toBe('scripts/util.mjs')
    })

    it('never resolves external packages or node: builtins (no package of that name in the repository)', () => {
      expect(resolveImportPath('client/src/App.tsx', 'react', known)).toBeNull()
      expect(resolveImportPath('server/src/db/client.ts', 'node:path', known)).toBeNull()
      expect(resolveImportPath('client/src/App.tsx', '@tanstack/react-query', known)).toBeNull()
      expect(resolveImportPath('client/src/App.tsx', 'react?raw', known)).toBeNull()
    })

    it('returns null for a relative specifier with no matching file', () => {
      expect(resolveImportPath('client/src/App.tsx', './missing.js', known)).toBeNull()
      expect(resolveImportPath('client/src/App.tsx', './missing', known)).toBeNull()
    })
  })

  // #466: bundlers (Vite) take a `?query` or `#hash` after the path; the file is the path before it.
  describe('query and hash suffixes', () => {
    it('resolves ./x.md?raw to x.md', () => {
      expect(resolveImportPath('client/src/App.tsx', './content/intro.md?raw', known)).toBe('client/src/content/intro.md')
    })

    it('resolves ?url, ?worker and #hash suffixes, extensionless and through @/', () => {
      expect(resolveImportPath('client/src/App.tsx', './assets/logo.svg?url', known)).toBe('client/src/assets/logo.svg')
      expect(resolveImportPath('client/src/App.tsx', './workers/parse?worker', known)).toBe('client/src/workers/parse.ts')
      expect(resolveImportPath('client/src/App.tsx', './workers/parse.js?worker&inline', known)).toBe(
        'client/src/workers/parse.ts',
      )
      expect(resolveImportPath('client/src/App.tsx', '@/assets/logo.svg#icon', known)).toBe('client/src/assets/logo.svg')
    })

    it('returns null when the file before the suffix does not exist', () => {
      expect(resolveImportPath('client/src/App.tsx', './content/missing.md?raw', known)).toBeNull()
    })
  })

  describe('TypeScript ESM `.js` specifiers (NodeNext/bundler style)', () => {
    it('maps ./x.js to x.ts (the dominant server import style)', () => {
      expect(resolveImportPath('server/src/repositories/extraction-queue.ts', './import-resolution.js', known)).toBe(
        'server/src/repositories/import-resolution.ts',
      )
    })

    it('maps ../x.js across directories to x.ts', () => {
      expect(resolveImportPath('server/src/repositories/extraction-queue.ts', '../db/client.js', known)).toBe(
        'server/src/db/client.ts',
      )
    })

    it('maps ./x.js to x.tsx', () => {
      expect(resolveImportPath('client/src/App.tsx', './components/graph/GraphCanvas.js', known)).toBe(
        'client/src/components/graph/GraphCanvas.tsx',
      )
    })

    it('maps ./x.jsx to x.tsx', () => {
      expect(resolveImportPath('client/src/App.tsx', './components/ui/button.jsx', known)).toBe(
        'client/src/components/ui/button.tsx',
      )
    })

    it('maps an explicit ./dir/index.js to dir/index.ts', () => {
      expect(resolveImportPath('server/src/repositories/extraction-queue.ts', '../graph/index.js', known)).toBe(
        'server/src/graph/index.ts',
      )
    })

    it('maps an explicit ./dir/index.js to dir/index.tsx', () => {
      expect(resolveImportPath('client/src/App.tsx', './pages/vault/index.js', known)).toBe(
        'client/src/pages/vault/index.tsx',
      )
    })

    it('maps ./x.mjs to x.mts', () => {
      expect(resolveImportPath('tools/gen.mts', './load.mjs', known)).toBe('tools/load.mts')
    })

    it('maps ./x.cjs to x.cts', () => {
      expect(resolveImportPath('tools/gen.mts', './compat.cjs', known)).toBe('tools/compat.cts')
    })

    it('prefers the TypeScript source when both x.ts and x.js exist (tsc semantics)', () => {
      expect(resolveImportPath('dual/main.ts', './thing.js', known)).toBe('dual/thing.ts')
    })
  })

  describe('.mts/.cts/.mjs/.cjs as candidate extensions (#451)', () => {
    it('resolves an extensionless import to x.mts and x.cts', () => {
      expect(resolveImportPath('tools/gen.mts', './load', known)).toBe('tools/load.mts')
      expect(resolveImportPath('tools/gen.mts', './compat', known)).toBe('tools/compat.cts')
    })

    it('resolves an extensionless import to x.mjs and x.cjs', () => {
      expect(resolveImportPath('scripts/build.mjs', './util', known)).toBe('scripts/util.mjs')
      expect(resolveImportPath('scripts/build.mjs', './legacy', known)).toBe('scripts/legacy.cjs')
    })

    it('resolves a directory import to its index.mts or index.cjs', () => {
      expect(resolveImportPath('esm/main.mts', './lib', known)).toBe('esm/lib/index.mts')
      expect(resolveImportPath('cjs/main.cjs', './lib', known)).toBe('cjs/lib/index.cjs')
    })

    it('prefers the TypeScript source when both x.mts and x.mjs exist', () => {
      expect(resolveImportPath('esm/main.mts', './both', known)).toBe('esm/both.mts')
      expect(resolveImportPath('esm/main.mts', './both.mjs', known)).toBe('esm/both.mts')
    })
  })

  describe('`@/` path alias (client tsconfig paths "@/*": ["./src/*"], vite alias "@" -> ./src)', () => {
    it('resolves @/x from a client file to client/src/x.ts', () => {
      expect(resolveImportPath('client/src/components/ui/button.tsx', '@/lib/utils', known)).toBe(
        'client/src/lib/utils.ts',
      )
    })

    it('resolves @/x to a .ts sibling module', () => {
      expect(resolveImportPath('client/src/components/ui/button.tsx', '@/components/ui/button-variants', known)).toBe(
        'client/src/components/ui/button-variants.ts',
      )
    })

    it('resolves @/x.js to x.tsx', () => {
      expect(resolveImportPath('client/src/App.tsx', '@/components/graph/GraphCanvas.js', known)).toBe(
        'client/src/components/graph/GraphCanvas.tsx',
      )
    })

    it('resolves an @/ directory import to its index file', () => {
      expect(resolveImportPath('client/src/App.tsx', '@/components/ui', known)).toBe('client/src/components/ui/index.ts')
    })

    it('resolves @/ against the src root of the importing package, not another package', () => {
      expect(resolveImportPath('apps/web/src/pages/home.tsx', '@/lib/utils', known)).toBe('apps/web/src/lib/utils.ts')
    })

    it('returns null for @/ when the target does not exist', () => {
      expect(resolveImportPath('client/src/App.tsx', '@/lib/nope', known)).toBeNull()
    })
  })
})
