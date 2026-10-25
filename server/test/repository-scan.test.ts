import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FILE_BYTES, readRepositoryFiles } from '../src/repositories/fs-scan.js'

// The one size/NUL rule of git and local-path scans (#923): a skipped file is
// listed in `skipped` with its reason (the seam #465 reports from) and left
// out of `currentPaths`, so the store deletes an earlier row for it.

let root: string | null = null
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

describe('readRepositoryFiles', () => {
  it('skips files over MAX_FILE_BYTES or with a NUL byte, and keeps the rest current', async () => {
    root = await mkdtemp(join(tmpdir(), 'chapters-scan-'))
    await writeFile(join(root, 'ok.ts'), 'export const ok = 1\n')
    await writeFile(join(root, 'at-cap.txt'), 'a'.repeat(MAX_FILE_BYTES))
    await writeFile(join(root, 'over-cap.txt'), 'a'.repeat(MAX_FILE_BYTES + 1))
    await writeFile(join(root, 'stray-nul.ts'), 'const a = 1\0\n')
    await writeFile(join(root, 'blob'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))

    const listed = ['ok.ts', 'at-cap.txt', 'over-cap.txt', 'stray-nul.ts', 'blob', 'missing.ts']
    const scan = await readRepositoryFiles(root, listed, 'test')

    expect(scan.files.map((f) => f.path)).toEqual(['ok.ts', 'at-cap.txt'])
    expect(scan.files[0]?.content).toBe('export const ok = 1\n')
    expect(scan.skipped).toEqual([
      { path: 'over-cap.txt', reason: 'too_large' },
      { path: 'stray-nul.ts', reason: 'binary' },
      { path: 'blob', reason: 'binary' },
    ])
    // A file that fails to read stays current: its row is kept until a scan can decide.
    expect(scan.currentPaths).toEqual(['ok.ts', 'at-cap.txt', 'missing.ts'])
  })
})
