// node --test 'lab/lib/*.test.ts' (run by CI `checks`). restart-extraction
// clones the fixture the way git-sync.ts does (ls-remote HEAD, then a
// depth-1 clone); the fixture must hold exactly the tracked tree of the
// commit under test and must not move when the source repository does (#767).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { buildPinnedRepo, serveGit } from './git-fixture.ts'

// Async on purpose: the server under test runs in this process.
async function git(args: string[], cwd?: string) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
  return (await promisify(execFile)('git', args, { cwd, env })).stdout.trim()
}

test('serves the tracked tree of the pinned commit; a later commit to the source does not change it', async () => {
  const src = mkdtempSync(join(tmpdir(), 'fixture-src-'))
  const out = mkdtempSync(join(tmpdir(), 'fixture-out-'))
  await git(['init', '-q', '-b', 'dev'], src)
  writeFileSync(join(src, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(src, 'b.md'), '# b\n')
  writeFileSync(join(src, '.gitignore'), 'ignored.txt\n')
  await git(['add', '-A'], src)
  await git(['commit', '-q', '--no-gpg-sign', '-m', 'one'], src)
  const pinned = await git(['rev-parse', 'HEAD'], src)
  writeFileSync(join(src, 'ignored.txt'), 'untracked secret\n')
  writeFileSync(join(src, 'untracked.ts'), 'not committed\n')

  const repo = buildPinnedRepo(src, 'fixture')
  // dev moves after the fixture was built (the #767 case: a merge mid-run).
  writeFileSync(join(src, 'c.ts'), 'export const c = 3\n')
  await git(['add', 'c.ts'], src)
  await git(['commit', '-q', '--no-gpg-sign', '-m', 'two'], src)

  const server = await serveGit(repo.root, '127.0.0.1')
  try {
    const url = `http://127.0.0.1:${server.port}/fixture.git`
    const [remoteHead] = (await git(['ls-remote', url, 'HEAD'])).split(/\s+/)
    assert.equal(remoteHead, repo.commit)
    assert.equal(repo.sourceCommit, pinned)
    for (const n of [1, 2]) {
      const dest = join(out, `clone${n}`)
      await git(['clone', '-q', '--depth', '1', url, dest])
      assert.equal(await git(['rev-parse', 'HEAD'], dest), repo.commit)
      assert.deepEqual((await git(['ls-files'], dest)).split('\n'), ['.gitignore', 'a.ts', 'b.md'])
    }
    // Read-only: a push is refused.
    await assert.rejects(git(['-C', join(out, 'clone1'), 'push', url, 'HEAD:refs/heads/other']))
  } finally {
    await server.close()
    repo.close()
    rmSync(src, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})
