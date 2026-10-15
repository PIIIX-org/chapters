import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, repositoryFileImports, repositoryFiles, repositoryFileSymbols } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import {
  countPendingExtractions,
  flushExtraction,
  scheduleMissingExtractions,
} from '../src/repositories/extraction-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { createActiveUser } from './helpers.js'

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
    expect(indexFile.embedding).not.toBeNull()

    const symbols = await db
      .select()
      .from(repositoryFileSymbols)
      .where(eq(repositoryFileSymbols.fileId, indexFile.id))
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

  it('embeds an unsupported-language file without producing import/symbol rows', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(repo.id, [{ path: 'README.rs', content: 'fn main() {}' }], ['README.rs'])
    await flushExtraction()

    const file = await fileByPath(repo.id, 'README.rs')
    expect(file.embedding).not.toBeNull()
    const symbols = await db
      .select()
      .from(repositoryFileSymbols)
      .where(eq(repositoryFileSymbols.fileId, file.id))
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
    expect(await db.select().from(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, readable.id))).toHaveLength(1)

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
    expect(file.embedding).not.toBeNull()
    expect(await db.select().from(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file.id))).toHaveLength(0)
    expect(await db.select().from(repositoryFileImports).where(eq(repositoryFileImports.sourceFileId, file.id))).toHaveLength(0)
  })

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

    expect((await fileByPath(repo.id, 'notes/first.txt')).embedding).toBeNull()
    expect((await fileByPath(repo.id, 'notes/second.txt')).embedding).not.toBeNull()
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
    expect((await fileByPath(repo.id, 'src/lost.ts')).embedding).toBeNull()
    expect(await countPendingExtractions(repo.id)).toBe(1)

    expect(await scheduleMissingExtractions()).toBeGreaterThanOrEqual(1)
    await flushExtraction()

    const file = await fileByPath(repo.id, 'src/lost.ts')
    expect(file.embedding).not.toBeNull()
    const symbols = await db.select().from(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file.id))
    expect(symbols.map((s) => s.name)).toEqual(['lost'])
    expect(await countPendingExtractions(repo.id)).toBe(0)
  })
})
