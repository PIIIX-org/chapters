import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GitignoreRules,
  SKIP_SAMPLE_PER_REASON,
  scanRepository,
  skippedField,
  summarizeSkips,
} from '../src/repositories/fs-scan.js'
import { startWatching } from '../src/repositories/local-watch.js'

// #465: the scan's ignore rules (git: none; local: .gitignore files), the
// file cap, and the per-reason skip summary.

let dirs: string[] = []
const stops: Array<() => void> = []
afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scan-rules-'))
  dirs.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

describe('GitignoreRules', () => {
  it('applies .git/info/exclude, the root and nested .gitignore files, deepest rule winning', async () => {
    const root = await makeTree({
      '.git/info/exclude': 'secret.txt\n',
      '.gitignore': 'dist/\n*.log\n',
      'pkg/.gitignore': '!keep.log\nlocal/\n',
    })
    const rules = new GitignoreRules(root)
    expect(rules.ignores('secret.txt', false)).toBe(true)
    expect(rules.ignores('dist', true)).toBe(true)
    // `dist/` names a directory only.
    expect(rules.ignores('dist', false)).toBe(false)
    expect(rules.ignores('a.log', false)).toBe(true)
    expect(rules.ignores('pkg/keep.log', false)).toBe(false)
    expect(rules.ignores('pkg/other.log', false)).toBe(true)
    expect(rules.ignores('pkg/local', true)).toBe(true)
    expect(rules.ignores('local', true)).toBe(false)
    // With a root .gitignore, node_modules is up to it.
    expect(rules.ignores('node_modules', true)).toBe(false)
  })

  it('skips node_modules by default only when there is no root .gitignore, and clear() rereads', async () => {
    const root = await makeTree({ 'a.ts': '' })
    const rules = new GitignoreRules(root)
    expect(rules.ignores('node_modules', true)).toBe(true)
    expect(rules.ignores('pkg/node_modules', true)).toBe(true)
    await writeFile(join(root, '.gitignore'), 'out/\n')
    expect(rules.ignores('out', true)).toBe(false)
    rules.clear()
    expect(rules.ignores('out', true)).toBe(true)
    expect(rules.ignores('node_modules', true)).toBe(false)
  })

  it('matches case-sensitively, as git does by default, unless .git/config sets core.ignorecase', async () => {
    const files = { '.gitignore': '/Data/\n*.LOG\n' }
    const sensitive = new GitignoreRules(await makeTree(files))
    expect(sensitive.ignores('data', true)).toBe(false)
    expect(sensitive.ignores('a.log', false)).toBe(false)
    expect(sensitive.ignores('Data', true)).toBe(true)
    expect(sensitive.ignores('a.LOG', false)).toBe(true)

    const explicitFalse = new GitignoreRules(
      await makeTree({ ...files, '.git/config': '[core]\n\tignorecase = false\n' }),
    )
    expect(explicitFalse.ignores('data', true)).toBe(false)

    const insensitive = new GitignoreRules(
      await makeTree({ ...files, '.git/config': '[core]\n\trepositoryformatversion = 0\n\tignoreCase = true\n' }),
    )
    expect(insensitive.ignores('data', true)).toBe(true)
    expect(insensitive.ignores('a.log', false)).toBe(true)
  })
})

describe('scanRepository', () => {
  it('git (no rules) lists every file but .git, binaries by extension aside', async () => {
    const root = await makeTree({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.gitignore': 'build/\n',
      'build/a.ts': 'a',
      'node_modules/b.js': 'b',
      'c.png': 'png',
    })
    const scan = await scanRepository(root, null, 'test')
    expect(scan.currentPaths.sort()).toEqual(['.gitignore', 'build/a.ts', 'node_modules/b.js'])
    expect(scan.skipped).toEqual([{ path: 'c.png', reason: 'binary' }])
  })

  it('counts files past the cap as over_file_cap and leaves them out of currentPaths', async () => {
    const root = await makeTree({ 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c', 'd.ts': 'd' })
    const scan = await scanRepository(root, new GitignoreRules(root), 'test', 3)
    expect(scan.currentPaths).toHaveLength(3)
    const over = scan.skipped.filter((s) => s.reason === 'over_file_cap')
    expect(over).toHaveLength(1)
    expect(scan.currentPaths).not.toContain(over[0]!.path)
    expect(summarizeSkips(scan.skipped)).toMatchObject({ over_file_cap: 1, too_large: 0, binary: 0, ignored: 0 })
  })
})

describe('summarizeSkips / skippedField', () => {
  it('counts every skip and samples at most SKIP_SAMPLE_PER_REASON paths per reason', () => {
    const binaries = Array.from({ length: 8 }, (_, i) => ({ path: `b${i}.png`, reason: 'binary' as const }))
    const summary = summarizeSkips([...binaries, { path: 'dist/', reason: 'ignored' }])
    expect(summary.binary).toBe(8)
    expect(summary.ignored).toBe(1)
    expect(summary.sample).toEqual([...binaries.slice(0, SKIP_SAMPLE_PER_REASON), { path: 'dist/', reason: 'ignored' }])
    expect(skippedField(summary)).toEqual({ skipped: summary })
  })

  it('omits the field when nothing was skipped or nothing is recorded', () => {
    expect(skippedField(summarizeSkips([]))).toEqual({})
    expect(skippedField(null)).toEqual({})
  })
})

// Real file-system events through chokidar: fake timers can't drive them, so
// wait out the 300 ms debounce (as repository-local-watch.test does).
const settle = () => new Promise((r) => setTimeout(r, 900))

describe('local watcher follows .gitignore', () => {
  it('does not sync for a change under an ignored path', async () => {
    const root = await makeTree({ '.gitignore': 'dist/\n', 'a.ts': 'a', 'dist/out.js': 'x' })
    let syncs = 0
    stops.push(startWatching('scan-rules-test', root, async () => void syncs++))
    await settle()
    const initial = syncs
    expect(initial).toBeGreaterThan(0)

    await writeFile(join(root, 'dist', 'out.js'), 'changed')
    await settle()
    expect(syncs).toBe(initial)

    await writeFile(join(root, 'b.ts'), 'b')
    await settle()
    expect(syncs).toBeGreaterThan(initial)
  })

  it('watches a nested directory a .gitignore change un-ignores, and stops when it is ignored again', async () => {
    const root = await makeTree({ '.gitignore': 'a/b/gen/\n', 'a/b/keep.ts': 'k', 'a/b/gen/x.ts': 'x' })
    let syncs = 0
    stops.push(startWatching('scan-rules-test', root, async () => void syncs++))
    await settle()

    // Un-ignore: the .gitignore edit itself syncs once, then edits under gen/ must too.
    await writeFile(join(root, '.gitignore'), '')
    await settle()
    let before = syncs
    await writeFile(join(root, 'a', 'b', 'gen', 'x.ts'), 'edited')
    await settle()
    expect(syncs).toBeGreaterThan(before)
    before = syncs
    await writeFile(join(root, 'a', 'b', 'gen', 'y.ts'), 'added')
    await settle()
    expect(syncs).toBeGreaterThan(before)

    // Ignore again: edits under gen/ no longer sync.
    await writeFile(join(root, '.gitignore'), 'a/b/gen/\n')
    await settle()
    before = syncs
    await writeFile(join(root, 'a', 'b', 'gen', 'x.ts'), 'edited again')
    await settle()
    expect(syncs).toBe(before)
  })

  it('a .git/info/exclude change re-reads the rules too', async () => {
    const root = await makeTree({ '.git/info/exclude': 'gen/\n', '.gitignore': '', 'gen/x.ts': 'x' })
    let syncs = 0
    stops.push(startWatching('scan-rules-test', root, async () => void syncs++))
    await settle()
    await writeFile(join(root, '.git', 'info', 'exclude'), '')
    await settle()
    const before = syncs
    await writeFile(join(root, 'gen', 'x.ts'), 'edited')
    await settle()
    expect(syncs).toBeGreaterThan(before)
  })
})
