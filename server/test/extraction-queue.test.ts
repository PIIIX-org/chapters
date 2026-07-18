import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
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

    const indexFile = (
      await db.select().from(repositoryFiles).where(eq(repositoryFiles.path, 'src/index.ts'))
    )[0]!
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
    const aFile = (
      await db.select().from(repositoryFiles).where(eq(repositoryFiles.path, 'src/a.ts'))
    )[0]!
    expect(imports[0]!.resolvedTargetFileId).toBe(aFile.id)
  })

  it('embeds an unsupported-language file without producing import/symbol rows', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(repo.id, [{ path: 'README.rs', content: 'fn main() {}' }], ['README.rs'])
    await flushExtraction()

    const file = (await db.select().from(repositoryFiles).where(eq(repositoryFiles.path, 'README.rs')))[0]!
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
    const before = (await db.select().from(repositoryFiles).where(eq(repositoryFiles.path, 'x.ts')))[0]!

    const result = await syncRepositoryFiles(repo.id, [{ path: 'x.ts', content: 'export const x = 1' }], ['x.ts'])
    await flushExtraction()
    expect(result.unchanged).toBe(1)
    const after = (await db.select().from(repositoryFiles).where(eq(repositoryFiles.path, 'x.ts')))[0]!
    expect(after.updatedAt).toEqual(before.updatedAt)
  })
})
