// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { build, type Rollup } from 'vite'
type OutputChunk = Rollup.OutputChunk
type OutputAsset = Rollup.OutputAsset
type RollupOutput = Rollup.RollupOutput
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

const BUDGET_BYTES = 300 * 1024
const GRAPH_CANVAS_SUFFIX = 'components/graph/GraphCanvas.tsx'

function isChunk(o: OutputChunk | OutputAsset): o is OutputChunk {
  return o.type === 'chunk'
}

describe('client bundle budget', () => {
  // This is the one deliberately slow test in the client suite: it runs a
  // real production Vite build (esbuild + Rollup + the Tailwind plugin) to
  // get real chunk graphs and real minified/gzipped sizes. Nothing short of
  // an actual build can catch "someone turned the lazy graph import back
  // into a static one" or "someone added a heavy dependency to the shell" —
  // those are exactly the regressions spec decision 9 and perf rule 6 exist
  // to prevent, and only the real bundler output can enforce them.
  it(
    'keeps the initial shell under 300KB gzipped and the graph renderer in a lazy chunk',
    { timeout: 120_000 },
    async () => {
      const outDir = mkdtempSync(path.join(tmpdir(), 'chapters-bundle-'))
      const clientRoot = path.resolve(__dirname, '..')

      // Vitest sets process.env.NODE_ENV = 'test'. Vite's define plugin
      // prefers an already-set process.env.NODE_ENV over the `mode` option
      // passed to build(), so leaving it as 'test' silently produces an
      // unminified, dev-mode React build — inflating the gzip size by ~60KB
      // and defeating the point of this test. Force real production output.
      const previousNodeEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      let result: RollupOutput
      try {
        result = (await build({
          root: clientRoot,
          configFile: path.resolve(clientRoot, 'vite.config.ts'),
          mode: 'production',
          logLevel: 'silent',
          build: {
            outDir,
            write: false,
            emptyOutDir: false,
          },
        })) as RollupOutput
      } finally {
        process.env.NODE_ENV = previousNodeEnv
      }

      const output = result.output
      const chunks = output.filter(isChunk)
      const cssAssets = output.filter(
        (o): o is OutputAsset => o.type === 'asset' && o.fileName.endsWith('.css'),
      )

      const entry = chunks.find((c) => c.isEntry)
      expect(entry, 'expected exactly one entry chunk in the build output').toBeDefined()

      const byFileName = new Map(chunks.map((c) => [c.fileName, c]))

      // Walk only *static* imports from the entry — this is what a browser
      // must fetch and execute before first paint.
      const staticallyReachable = new Set<string>()
      const stack = [entry!.fileName]
      while (stack.length > 0) {
        const fileName = stack.pop()!
        if (staticallyReachable.has(fileName)) continue
        staticallyReachable.add(fileName)
        const chunk = byFileName.get(fileName)
        if (!chunk) continue
        for (const imported of chunk.imports) {
          if (!staticallyReachable.has(imported)) stack.push(imported)
        }
      }

      const staticChunkBytes = [...staticallyReachable]
        .map((fileName) => byFileName.get(fileName))
        .filter((c): c is OutputChunk => c !== undefined)
        .reduce((sum, c) => sum + gzipSync(Buffer.from(c.code)).length, 0)

      const cssBytes = cssAssets.reduce(
        (sum, asset) => sum + gzipSync(Buffer.from(asset.source)).length,
        0,
      )

      const totalBytes = staticChunkBytes + cssBytes

      // Find the chunk that contains GraphCanvas, wherever the bundler put it.
      const graphChunk = chunks.find((c) => {
        const ids = c.moduleIds.length > 0 ? c.moduleIds : Object.keys(c.modules)
        return ids.some((id) => id.endsWith(GRAPH_CANVAS_SUFFIX))
      })
      expect(graphChunk, 'expected a chunk containing GraphCanvas.tsx').toBeDefined()

      // It must not be part of the entry's static import graph...
      expect(staticallyReachable.has(graphChunk!.fileName)).toBe(false)

      // ...and it must actually be reachable, just only dynamically —
      // otherwise this assertion would pass vacuously if the graph chunk
      // were simply never referenced at all.
      const dynamicallyReachable = new Set<string>()
      const dynStack = [...entry!.dynamicImports]
      const visited = new Set<string>()
      while (dynStack.length > 0) {
        const fileName = dynStack.pop()!
        if (visited.has(fileName)) continue
        visited.add(fileName)
        dynamicallyReachable.add(fileName)
        const chunk = byFileName.get(fileName)
        if (!chunk) continue
        for (const imported of chunk.imports) dynStack.push(imported)
        for (const imported of chunk.dynamicImports) dynStack.push(imported)
      }
      expect(dynamicallyReachable.has(graphChunk!.fileName)).toBe(true)

      expect(totalBytes).toBeLessThan(BUDGET_BYTES)
    },
  )
})
