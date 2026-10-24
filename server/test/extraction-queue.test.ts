import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { and, count, eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { blocks, repositories, repositoryFileImports, repositoryFiles } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import {
  backfillUnresolvedImports,
  countPendingExtractions,
  flushExtraction,
  scheduleMissingExtractions,
} from '../src/repositories/extraction-queue.js'
import { EXTRACTOR_VERSION } from '../src/repositories/extraction.js'
import { embedder } from '../src/search/embeddings.js'
import { createActiveUser, fileEmbedding, symbolBlocks } from './helpers.js'

async function makeRepo() {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'extraction-test', ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning()
  return repo!
}

/** Test rows are never reset between test files sharing this DB — always scope by repositoryId too. */
async function fileByPath(repositoryId: string, path: string) {
  const rows = await db
    .select()
    .from(repositoryFiles)
    .where(and(eq(repositoryFiles.repositoryId, repositoryId), eq(repositoryFiles.path, path)))
  return rows[0]!
}

describe('extraction queue', () => {
  it('extracts imports and symbols for a supported language, and embeds the file', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(
      repo.id,
      [
        { path: 'src/a.ts', content: 'export function helper() { return 1 }' },
        { path: 'src/index.ts', content: "import { helper } from './a'\nexport function main() { return helper() }" },
      ],
      ['src/a.ts', 'src/index.ts'],
    )
    await flushExtraction()

    const indexFile = await fileByPath(repo.id, 'src/index.ts')
    expect(await fileEmbedding(indexFile.id)).not.toBeNull()

    const symbols = await symbolBlocks(indexFile.id)
    expect(symbols.map((s) => s.name)).toEqual(['main'])

    const imports = await db
      .select()
      .from(repositoryFileImports)
      .where(eq(repositoryFileImports.sourceFileId, indexFile.id))
    expect(imports).toHaveLength(1)
    expect(imports[0]!.targetPath).toBe('./a')
    const aFile = await fileByPath(repo.id, 'src/a.ts')
    expect(imports[0]!.resolvedTargetFileId).toBe(aFile.id)
  })

  it('resolves cross-file imports regardless of order within the same sync batch', async () => {
    const repo = await makeRepo()
    // The importer is listed BEFORE the file it imports — extraction must
    // not run until the whole batch (including the dependency) is persisted.
    await syncRepositoryFiles(
      repo.id,
      [
        { path: 'src/main.ts', content: "import { helper } from './helper'\nexport function run() { return helper() }" },
        { path: 'src/helper.ts', content: 'export function helper() { return 42 }' },
      ],
      ['src/main.ts', 'src/helper.ts'],
    )
    await flushExtraction()

    const mainFile = await fileByPath(repo.id, 'src/main.ts')
    const helperFile = await fileByPath(repo.id, 'src/helper.ts')
    const imports = await db
      .select()
      .from(repositoryFileImports)
      .where(eq(repositoryFileImports.sourceFileId, mainFile.id))
    expect(imports[0]?.resolvedTargetFileId).toBe(helperFile.id)
  })

  it('resolves TypeScript ESM `.js` specifiers and the client `@/` alias to their .ts/.tsx files', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(
      repo.id,
      [
        {
          path: 'client/src/App.tsx',
          content:
            "import { Button } from './components/Button.js'\nimport { cn } from '@/lib/utils'\nexport function App() { return cn(Button()) }",
        },
        { path: 'client/src/components/Button.tsx', content: 'export function Button() { return 1 }' },
        { path: 'client/src/lib/utils.ts', content: 'export function cn(x: number) { return x }' },
      ],
      ['client/src/App.tsx', 'client/src/components/Button.tsx', 'client/src/lib/utils.ts'],
    )
    await flushExtraction()

    const app = await fileByPath(repo.id, 'client/src/App.tsx')
    const button = await fileByPath(repo.id, 'client/src/components/Button.tsx')
    const utils = await fileByPath(repo.id, 'client/src/lib/utils.ts')
    const imports = await db
      .select()
      .from(repositoryFileImports)
      .where(eq(repositoryFileImports.sourceFileId, app.id))
    const resolvedBySpecifier = Object.fromEntries(imports.map((i) => [i.targetPath, i.resolvedTargetFileId]))
    expect(resolvedBySpecifier).toEqual({
      './components/Button.js': button.id,
      '@/lib/utils': utils.id,
    })
  })

  it('extracts .mts files and resolves `./x.mjs` to x.mts; a .tsx component with JSX keeps its symbols (#449, #451)', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(
      repo.id,
      [
        { path: 'tools/gen.mts', content: "import { load } from './load.mjs'\nexport function gen() { return load() }" },
        { path: 'tools/load.mts', content: 'export function load() { return 1 }' },
        {
          path: 'client/src/Card.tsx',
          content: [
            "import { gen } from '../../tools/gen.mjs'",
            'export function Card() {',
            '  return <div className="card">{gen()}</div>',
            '}',
            'export default function Page() { return <Card /> }',
          ].join('\n'),
        },
      ],
      ['tools/gen.mts', 'tools/load.mts', 'client/src/Card.tsx'],
    )
    await flushExtraction()

    const gen = await fileByPath(repo.id, 'tools/gen.mts')
    const load = await fileByPath(repo.id, 'tools/load.mts')
    const card = await fileByPath(repo.id, 'client/src/Card.tsx')
    expect(gen.language).toBe('typescript')
    const genImports = await db.select().from(repositoryFileImports).where(eq(repositoryFileImports.sourceFileId, gen.id))
    expect(genImports.map((i) => [i.targetPath, i.resolvedTargetFileId])).toEqual([['./load.mjs', load.id]])
    const genSymbols = await symbolBlocks(gen.id)
    expect(genSymbols.map((s) => s.name)).toEqual(['gen'])

    const cardSymbols = await symbolBlocks(card.id)
    expect(cardSymbols.map((s) => [s.name, s.startLine, s.endLine]).sort()).toEqual([
      ['Card', 2, 4],
      ['Page', 5, 5],
    ])
    const cardImports = await db.select().from(repositoryFileImports).where(eq(repositoryFileImports.sourceFileId, card.id))
    expect(cardImports.map((i) => [i.targetPath, i.resolvedTargetFileId])).toEqual([['../../tools/gen.mjs', gen.id]])
  })

  it('backfills imports stored unresolved by an older resolver, from their raw target path', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(
      repo.id,
      [
        {
          path: 'server/src/queue.ts',
          content: "import { resolve } from './resolve.js'\nimport { eq } from 'drizzle-orm'\nexport const q = resolve(eq)",
        },
        { path: 'server/src/resolve.ts', content: 'export function resolve(x: unknown) { return x }' },
      ],
      ['server/src/queue.ts', 'server/src/resolve.ts'],
    )
    await flushExtraction()

    const queueFile = await fileByPath(repo.id, 'server/src/queue.ts')
    const resolveFile = await fileByPath(repo.id, 'server/src/resolve.ts')
    // Simulate rows written before `.js` -> `.ts` resolution existed.
    await db
      .update(repositoryFileImports)
      .set({ resolvedTargetFileId: null })
      .where(eq(repositoryFileImports.sourceFileId, queueFile.id))

    expect(await backfillUnresolvedImports()).toBeGreaterThanOrEqual(1)

    const imports = await db
      .select()
      .from(repositoryFileImports)
      .where(eq(repositoryFileImports.sourceFileId, queueFile.id))
    expect(Object.fromEntries(imports.map((i) => [i.targetPath, i.resolvedTargetFileId]))).toEqual({
      './resolve.js': resolveFile.id,
      'drizzle-orm': null,
    })
  })

  it('embeds an unsupported-language file without producing import/symbol rows', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(repo.id, [{ path: 'README.rs', content: 'fn main() {}' }], ['README.rs'])
    await flushExtraction()

    const file = await fileByPath(repo.id, 'README.rs')
    expect(await fileEmbedding(file.id)).not.toBeNull()
    const symbols = await symbolBlocks(file.id)
    expect(symbols).toHaveLength(0)
  })

  it('does not re-trigger extraction for an unchanged resync', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(repo.id, [{ path: 'x.ts', content: 'export const x = 1' }], ['x.ts'])
    await flushExtraction()
    const before = await fileByPath(repo.id, 'x.ts')

    const result = await syncRepositoryFiles(repo.id, [{ path: 'x.ts', content: 'export const x = 1' }], ['x.ts'])
    await flushExtraction()
    expect(result.unchanged).toBe(1)
    const after = await fileByPath(repo.id, 'x.ts')
    expect(after.updatedAt).toEqual(before.updatedAt)
  })

  it('gives a minified bundle a file embedding but no symbols, imports or per-symbol embeddings', async () => {
    const repo = await makeRepo()
    // A readable first version: its symbols must not survive the minified one.
    await syncRepositoryFiles(repo.id, [{ path: 'dist/cli.bundle.mjs', content: 'export function run() {}' }], [
      'dist/cli.bundle.mjs',
    ])
    await flushExtraction()
    const readable = await fileByPath(repo.id, 'dist/cli.bundle.mjs')
    expect(await symbolBlocks(readable.id)).toHaveLength(1)

    // Shaped like the production bundle that took the server down: hundreds of
    // declarations on a handful of very long lines.
    const line = Array.from({ length: 300 }, (_, i) => `function f${i}(t){return t+${i}}`).join('')
    const bundle = `#!/usr/bin/env node\nimport{a}from"./a.js";${line}\n${line.replaceAll('function f', 'function g')}\n`
    const embedSpy = vi.spyOn(embedder, 'embed')
    try {
      await syncRepositoryFiles(repo.id, [{ path: 'dist/cli.bundle.mjs', content: bundle }], ['dist/cli.bundle.mjs'])
      await flushExtraction()
      expect(embedSpy.mock.calls.map(([texts]) => texts.length)).toEqual([1])
    } finally {
      embedSpy.mockRestore()
    }

    const file = await fileByPath(repo.id, 'dist/cli.bundle.mjs')
    expect(await fileEmbedding(file.id)).not.toBeNull()
    expect(await symbolBlocks(file.id)).toHaveLength(0)
    expect(await db.select().from(repositoryFileImports).where(eq(repositoryFileImports.sourceFileId, file.id))).toHaveLength(0)
  })

  it('embeds at most ELARA_EMBED_MAX_SYMBOLS_PER_FILE symbols of a file, keeps every symbol, and records why (#496)', async () => {
    vi.stubEnv('ELARA_EMBED_MAX_SYMBOLS_PER_FILE', '3')
    const repo = await makeRepo()
    // Readable (one declaration per line), so the minified guard does not apply.
    const content = Array.from({ length: 5 }, (_, i) => `export function f${i}() { return ${i} }`).join('\n')
    const embedSpy = vi.spyOn(embedder, 'embed')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await syncRepositoryFiles(repo.id, [{ path: 'src/many.ts', content }], ['src/many.ts'])
      await flushExtraction()
      // The file text and the first three symbols: one call, four texts.
      expect(embedSpy.mock.calls.map(([texts]) => texts.length)).toEqual([4])
    } finally {
      embedSpy.mockRestore()
      warnSpy.mockRestore()
      vi.unstubAllEnvs()
    }

    const file = await fileByPath(repo.id, 'src/many.ts')
    expect(await fileEmbedding(file.id)).not.toBeNull()
    const symbols = await symbolBlocks(file.id)
    expect(symbols.map((s) => s.name)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4'])
    expect(symbols.map((s) => s.embedding !== null)).toEqual([true, true, true, false, false])
    expect(file.embeddingNote).toBe(
      'symbol embeddings capped by ELARA_EMBED_MAX_SYMBOLS_PER_FILE: 3 of 5 symbols embedded, the rest are keyword-searchable only',
    )

    // Back under the budget: a re-extraction clears the note.
    await syncRepositoryFiles(repo.id, [{ path: 'src/many.ts', content: 'export function only() {}' }], ['src/many.ts'])
    await flushExtraction()
    expect((await fileByPath(repo.id, 'src/many.ts')).embeddingNote).toBeNull()
  })

  it('under the per-file budget, embeds exported then other top-level symbols before methods (#450)', async () => {
    vi.stubEnv('ELARA_EMBED_MAX_SYMBOLS_PER_FILE', '3')
    const repo = await makeRepo()
    // A class with many methods opens the file: in document order its methods
    // would take the budget from the functions after it.
    const content = [
      'export class Store {',
      '  get(key: string) { return key }',
      '  set(key: string) { return key }',
      '  delete(key: string) { return key }',
      '  clear() {}',
      '}',
      'function helper() { return 1 }',
      'export const load = () => new Store()',
      'const unused = () => helper()',
    ].join('\n')
    const embedSpy = vi.spyOn(embedder, 'embed')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await syncRepositoryFiles(repo.id, [{ path: 'src/store.ts', content }], ['src/store.ts'])
      await flushExtraction()
      expect(embedSpy.mock.calls.map(([texts]) => texts.slice(1).map((t) => t.split('\n')[0]))).toEqual([
        ['class Store in src/store.ts', 'function load in src/store.ts', 'function helper in src/store.ts'],
      ])
    } finally {
      embedSpy.mockRestore()
      warnSpy.mockRestore()
      vi.unstubAllEnvs()
    }

    const file = await fileByPath(repo.id, 'src/store.ts')
    const symbols = await symbolBlocks(file.id)
    expect(symbols.map((s) => [s.kind, s.parent, s.name, s.embedding !== null])).toEqual([
      ['class', null, 'Store', true],
      ['method', 'Store', 'get', false],
      ['method', 'Store', 'set', false],
      ['method', 'Store', 'delete', false],
      ['method', 'Store', 'clear', false],
      ['function', null, 'helper', true],
      ['function', null, 'load', true],
      ['function', null, 'unused', false],
    ])
    expect(file.embeddingNote).toBe(
      'symbol embeddings capped by ELARA_EMBED_MAX_SYMBOLS_PER_FILE: 3 of 8 symbols embedded, the rest are keyword-searchable only',
    )
  })

  it('stores a file with more blocks and imports than one INSERT can bind, and replaces them (#450 review, #413)', async () => {
    // 14 parameters a block row and 4 an import row: one statement would pass
    // postgres.js's 65,534-parameter cap (12,002 x 15 and 17,000 x 4). Generated
    // constant tables reach this now that exported consts are symbols.
    vi.stubEnv('ELARA_EMBED_MAX_SYMBOLS_PER_FILE', '4')
    const repo = await makeRepo()
    const consts = Array.from({ length: 12_000 }, (_, i) => `export const K${i} = ${i}`)
    const imports = Array.from({ length: 17_000 }, (_, i) => `import './m${i}.js'`)
    const content = [...imports, ...consts].join('\n')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const countBlocks = async (fileId: string) =>
      (await db.select({ n: count() }).from(blocks).where(and(eq(blocks.ownerType, 'code'), eq(blocks.ownerId, fileId))))[0]!.n
    try {
      await syncRepositoryFiles(repo.id, [{ path: 'src/table.ts', content }], ['src/table.ts'])
      await flushExtraction()
      const file = await fileByPath(repo.id, 'src/table.ts')
      expect(await fileEmbedding(file.id)).not.toBeNull()
      expect(file.extractorVersion).toBe(EXTRACTOR_VERSION)
      // The file block, the file skeleton and one block per constant.
      expect(await countBlocks(file.id)).toBe(12_002)
      const [importRows] = await db.select({ n: count() }).from(repositoryFileImports).where(eq(repositoryFileImports.sourceFileId, file.id))
      expect(importRows!.n).toBe(17_000)

      // Half the constants go: the set is replaced whole, past the cap again.
      await syncRepositoryFiles(repo.id, [{ path: 'src/table.ts', content: [...imports, ...consts.slice(0, 6_000)].join('\n') }], ['src/table.ts'])
      await flushExtraction()
      const replaced = await fileByPath(repo.id, 'src/table.ts')
      expect(replaced.extractedHash).toBe(replaced.contentHash)
      expect(replaced.contentHash).not.toBe(file.contentHash)
      expect(await countBlocks(file.id)).toBe(6_002)
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  }, 180_000)

  it('one failing file does not stop the files queued after it, and stays counted as pending', async () => {
    const repo = await makeRepo()
    const embedSpy = vi.spyOn(embedder, 'embed').mockRejectedValueOnce(new Error('model crashed'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await syncRepositoryFiles(
        repo.id,
        [
          { path: 'notes/first.txt', content: 'first' },
          { path: 'notes/second.txt', content: 'second' },
        ],
        ['notes/first.txt', 'notes/second.txt'],
      )
      await flushExtraction()
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('extraction failed'), expect.any(Error))
    } finally {
      embedSpy.mockRestore()
      errorSpy.mockRestore()
    }

    expect((await fileEmbedding((await fileByPath(repo.id, 'notes/first.txt')).id))).toBeNull()
    expect((await fileEmbedding((await fileByPath(repo.id, 'notes/second.txt')).id))).not.toBeNull()
    expect(await countPendingExtractions(repo.id)).toBe(1)
  })

  it('boot catch-up extracts files whose queued extraction was lost, which an unchanged re-sync never re-enqueues', async () => {
    const repo = await makeRepo()
    // Persisted by a sync, but the process stopped before the in-memory queue reached it.
    const content = 'export function lost() { return 1 }'
    await db.insert(repositoryFiles).values({
      repositoryId: repo.id,
      path: 'src/lost.ts',
      language: 'typescript',
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      size: content.length,
    })

    const resync = await syncRepositoryFiles(repo.id, [{ path: 'src/lost.ts', content }], ['src/lost.ts'])
    await flushExtraction()
    expect(resync.unchanged).toBe(1)
    expect((await fileEmbedding((await fileByPath(repo.id, 'src/lost.ts')).id))).toBeNull()
    expect(await countPendingExtractions(repo.id)).toBe(1)

    expect(await scheduleMissingExtractions()).toBeGreaterThanOrEqual(1)
    await flushExtraction()

    const file = await fileByPath(repo.id, 'src/lost.ts')
    expect(await fileEmbedding(file.id)).not.toBeNull()
    const symbols = await symbolBlocks(file.id)
    expect(symbols.map((s) => s.name)).toEqual(['lost'])
    expect(await countPendingExtractions(repo.id)).toBe(0)
  })
})
