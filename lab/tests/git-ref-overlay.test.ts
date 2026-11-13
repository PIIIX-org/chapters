import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Check, LabTest } from '../lib/context.ts'
import { serveGit } from '../lib/git-fixture.ts'
import { settleRepo } from '../lib/fixlab.ts'
import { stringField } from '../lib/mcp.ts'

const test: LabTest = {
  name: 'git-ref-overlay',
  tier: 'fast',
  description: 'Real two-commit Git source: immutable ref reads/diff and private additions/deletions across code tools (#676/#471).',
  async run(ctx) {
    const checks: Check[] = []
    const root = mkdtempSync(join(tmpdir(), 'lab-ref-overlay-'))
    const work = join(root, 'work')
    mkdirSync(work)
    const identity = { ...process.env, GIT_AUTHOR_NAME: 'Ref lab', GIT_AUTHOR_EMAIL: 'ref@elara.local', GIT_COMMITTER_NAME: 'Ref lab', GIT_COMMITTER_EMAIL: 'ref@elara.local' }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: work, env: identity, encoding: 'utf8' }).trim()
    const old = 'export function baseOnly() { return 1 }\n'
    const next = 'export function branchOnly() { return 2 }\n'
    git('init', '-q', '-b', 'main')
    writeFileSync(join(work, 'api.ts'), old)
    git('add', '.')
    git('commit', '-q', '--no-gpg-sign', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    git('checkout', '-q', '-b', 'feature')
    writeFileSync(join(work, 'api.ts'), next)
    git('add', '.')
    git('commit', '-q', '--no-gpg-sign', '-m', 'feature')
    const commit = git('rev-parse', 'HEAD')
    git('clone', '-q', '--bare', work, join(root, 'fixture.git'))
    git('-C', join(root, 'fixture.git'), 'symbolic-ref', 'HEAD', 'refs/heads/main')
    const server = await serveGit(root)
    let repositoryId: string | undefined
    const data: Record<string, unknown> = { base, commit }
    try {
      const repo = await ctx.rest('admin').must<{ id: string }>('POST', '/api/repositories', { name: ctx.uniq('git-ref-overlay'), ingestionMethod: 'git', gitUrl: `http://host.docker.internal:${server.port}/fixture.git` })
      repositoryId = repo.id
      data.settled = await settleRepo(ctx, repo.id, 'ref base', { stallMs: 30_000, timeoutMs: 120_000, minFiles: 1 })
      const mcp = ctx.mcp('adminAccount')
      const overlay = '--- a/api.ts\n+++ b/api.ts\n@@ -1,1 +1,1 @@\n-export function branchOnly() { return 2 }\n+export function overlayOnly() { return 3 }\n--- /dev/null\n+++ b/caller.ts\n@@ -0,0 +1,2 @@\n+import { overlayOnly } from "./api.js"\n+export function useOverlay() { return overlayOnly() }\n'
      const run = async (tool: string, args: Record<string, unknown>) => {
        const result = await mcp.call(tool, { repositoryId: repo.id, budget_tokens: 10_000, ...args })
        data[`${tool}:${Object.keys(data).length}`] = result
        return result
      }
      const check = (name: string, ok: boolean, detail: unknown) => checks.push({ name, expected: 'selected immutable bytes, no default-index or session substitution', actual: ok ? 'matched' : 'mismatch', ok, detail, severity: 'high' })
      const read = await run('read_file', { ref: commit, path: 'api.ts', outline: false })
      check('ref read is commit-bound', read.ok && stringField(read.json, 'commit') === commit && stringField(read.json, 'content') === next, read)
      const edited = await run('read_file', { ref: commit, overlay, path: 'api.ts', outline: false })
      check('overlay read has modified bytes', edited.ok && stringField(edited.json, 'content') === 'export function overlayOnly() { return 3 }\n', edited)
      const symbols = await run('find_symbols', { ref: commit, overlay, query: 'overlayOnly' })
      check('overlay-only symbol has its real line', symbols.ok && symbols.text.includes('"name":"overlayOnly"') && symbols.text.includes('"startLine":1'), symbols)
      const deleted = await run('find_symbols', { ref: commit, overlay, query: 'branchOnly' })
      check('removed symbol is absent', deleted.ok && !deleted.text.includes('"name":"branchOnly"'), deleted)
      const refs = await run('find_symbols', { ref: commit, overlay, query: 'overlayOnly', refs: 'callers' })
      check('overlay callers resolve on the edited tree', refs.ok && refs.text.includes('caller.ts:2') && refs.text.includes('resolved'), refs)
      const routed = await run('search', { ref: commit, overlay, query: 'who calls overlayOnly', route: 'structural' })
      check('public structural route uses the private ref graph', routed.ok && stringField(routed.json, 'route') === 'structural' && stringField(routed.json, 'commit') === commit && routed.text.includes('caller.ts') && routed.text.includes('"startLine":2') && routed.text.includes('"confidence":"resolved"'), routed)
      const path = await run('search', { ref: commit, overlay, query: 'api.ts', route: 'path' })
      check('public path route reads overlaid bytes', path.ok && stringField(path.json, 'route') === 'path' && path.text.includes('overlayOnly') && !path.text.includes('branchOnly'), path)
      const conceptual = await run('search', { ref: commit, overlay, query: 'overlayOnly', route: 'conceptual' })
      check('conceptual override remains inside the selected view', conceptual.ok && stringField(conceptual.json, 'route') === 'conceptual' && stringField(conceptual.json, 'commit') === commit && conceptual.text.includes('overlayOnly') && !conceptual.text.includes('"symbolName":"branchOnly"'), conceptual)
      const grep = await run('grep', { ref: commit, overlay, pattern: 'branchOnly|overlayOnly' })
      check('grep uses base plus overlay', grep.ok && grep.text.includes('overlayOnly') && !grep.text.includes('branchOnly'), grep)
      const diff = await run('browse_repository', { ref: commit, diff: base, overlay })
      check('diff names both commits and overlay bytes', diff.ok && diff.text.includes(base) && diff.text.includes(commit) && diff.text.includes('+export function overlayOnly'), diff)
      const plain = await run('read_file', { ref: commit, path: 'api.ts', outline: false })
      check('overlay did not persist in the next call', plain.ok && stringField(plain.json, 'content') === next, plain)
      const indexed = await run('read_file', { path: 'api.ts', outline: false })
      check('default shared index remains on main', indexed.ok && stringField(indexed.json, 'content') === old && stringField(indexed.json, 'commit') === base, indexed)
      return { summary: 'Real smart-HTTP ref/overlay acceptance, with raw MCP answers and exact base/target identities.', checks, data }
    } finally {
      if (repositoryId) await ctx.rest('admin').must('DELETE', `/api/repositories/${repositoryId}`)
      await server.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
}
export default test
