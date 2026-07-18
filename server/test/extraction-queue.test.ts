import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, repositoryFileImports, repositoryFiles, repositoryFileSymbols } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
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
})
