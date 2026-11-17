import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { codeBlocks } from '../src/repositories/code-blocks.js'
import { VIEW_BLOCK_BOUNDS } from '../src/repositories/ref-index.js'
import { scoreDefinitions } from '../src/repositories/ref-queries.js'
import { MirrorReadLimitError, fetchQueryCommit, mirrorBytes } from '../src/repositories/git-mirror.js'
import { isTestPath } from '../src/repositories/code-edges.js'
import type { Definition } from '../src/repositories/code-queries.js'
import type { ExtractedSymbol } from '../src/repositories/extraction.js'

// #676 security review: what a repository reader can make a ref view or a ref fetch cost.

const symbol = (name: string, startLine: number): ExtractedSymbol => ({ name, kind: 'function', startLine, endLine: startLine, exported: true } as ExtractedSymbol)

describe('block generation bounds', () => {
  it('leaves an ordinary file byte-identical with and without the view bounds', () => {
    const content = Array.from({ length: 400 }, (_, i) => `export function f${i}() { return ${i} }`).join('\n') + '\n'
    const symbols = Array.from({ length: 400 }, (_, i) => symbol(`f${i}`, i + 1))
    const plain = codeBlocks('file', 'src/a.ts', content, symbols)
    expect(plain.some((b) => b.kind === 'skeleton')).toBe(true)
    expect(codeBlocks('file', 'src/a.ts', content, symbols, [], VIEW_BLOCK_BOUNDS)).toEqual(plain)
  })

  it('cuts first lines and caps the skeleton of a file with thousands of declarations on long lines', () => {
    // 150 lines of 900 characters, 30 declarations each: not minified by the live rule, but 4,500 declarations.
    const lines = Array.from({ length: 150 }, (_, row) => Array.from({ length: 30 }, (_, k) => `function d${row}_${k}(){}`).join(';').padEnd(900, ' '))
    const content = lines.join('\n') + '\n'
    const symbols = lines.flatMap((_, row) => Array.from({ length: 30 }, (_, k) => symbol(`d${row}_${k}`, row + 1)))
    const heapBefore = process.memoryUsage().heapUsed
    const blocks = codeBlocks('file', 'src/many.ts', content, symbols, [], VIEW_BLOCK_BOUNDS)
    const heapDelta = process.memoryUsage().heapUsed - heapBefore
    const skeleton = blocks.filter((b) => b.kind === 'skeleton').reduce((n, b) => n + b.embedText.length, 0)
    expect(skeleton).toBeLessThanOrEqual(VIEW_BLOCK_BOUNDS.skeletonChars + 'src/many.ts'.length + 1)
    // The unbounded skeleton would hold 4,500 x 900 characters (4 MB) for this one file.
    expect(blocks.filter((b) => b.kind === 'skeleton' && b.embedText.split('\n').slice(1).some((l) => l.length > VIEW_BLOCK_BOUNDS.lineChars))).toEqual([])
    expect(heapDelta).toBeLessThan(64 * 1024 * 1024)
  })
})

describe('orient scoring', () => {
  const def = (n: number, path: string): Definition => ({ id: `d${n}`, fileId: path, blockIds: [`b${n}`], path, name: `n${n}`, symbol: `n${n}`, kind: 'function', parent: null, line: n % 50 + 1, endLine: n % 50 + 2 })
  const edge = (target: Definition | null, path: string, over: { kind?: 'call' | 'test'; confidence?: 'resolved' | 'textual'; member?: boolean } = {}) => ({ path, kind: 'call' as 'call' | 'test', confidence: 'resolved' as 'resolved' | 'textual', member: false, target, ...over })

  it('ranks exactly as the per-definition edge scan did', () => {
    const defs = [def(1, 'src/a.ts'), def(2, 'src/b.ts'), def(3, 'src/c.ts'), def(4, 'src/c.test.ts'), def(5, 'lib/d.ts')]
    const focus = (p: string) => p.startsWith('lib/')
    const words = ['n2']
    const edges = [
      edge(defs[0]!, 'src/b.ts'), edge(defs[0]!, 'src/b.ts'), edge(defs[0]!, 'lib/d.ts'), edge(defs[0]!, 'src/a.ts'), edge(defs[0]!, 'src/c.test.ts'),
      edge(defs[0]!, 'src/c.ts', { confidence: 'textual' }), edge(defs[0]!, 'src/c.ts', { confidence: 'textual', member: true }), edge(defs[0]!, 'src/c.ts', { kind: 'test' }),
      edge(defs[1]!, 'src/a.ts'), edge(defs[2]!, 'lib/d.ts'), edge(defs[2]!, 'lib/d.ts'), edge(defs[4]!, 'src/a.ts', { confidence: 'textual' }), edge(null, 'src/a.ts'),
    ]
    const naive = defs.filter((d) => !isTestPath(d.path)).map((d) => {
      const uses = edges.filter((e) => e.target?.id === d.id && e.path !== d.path && !isTestPath(e.path) && e.kind !== 'test' && (e.confidence === 'resolved' || !e.member))
      const refs = uses.filter((e) => e.confidence === 'resolved').length
      const guessed = uses.length - refs
      const score = refs + 0.5 * guessed + 5 * uses.filter((e) => e.confidence === 'resolved' && focus(e.path)).length + (focus(d.path) ? 20 : 0) + (words.some((w) => d.symbol.toLowerCase().includes(w)) ? 10 : 0) + (words.some((w) => d.path.toLowerCase().includes(w)) ? 5 : 0)
      return { d, refs, guessed, score }
    }).sort((a, b) => b.score - a.score || (a.d.path < b.d.path ? -1 : a.d.path > b.d.path ? 1 : 0) || a.d.line - b.d.line)
    expect(scoreDefinitions(defs.filter((d) => !isTestPath(d.path)), edges, focus, words)).toEqual(naive)
  })

  it('scores a 1,000-file view with 100,000 definitions and 100,000 edges in linear time', () => {
    const defs: Definition[] = []
    for (let f = 0; f < 1000; f++) for (let k = 0; k < 100; k++) defs.push(def(f * 100 + k, `src/f${f}.ts`))
    const edges = defs.map((d, i) => edge(defs[(i * 7919 + 13) % defs.length]!, `src/f${(Math.floor(i / 100) + 1) % 1000}.ts`))
    const started = performance.now()
    const scored = scoreDefinitions(defs, edges, () => false, [])
    expect(scored).toHaveLength(100_000)
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(scored.reduce((n, s) => n + s.refs, 0)).toBe(edges.filter((e) => e.path !== e.target!.path).length)
  })
})

describe('bounded query fetch', () => {
  let root: string
  let mirror: string
  let url: string
  let commit: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elara-bounds-'))
    mirror = join(root, 'mirror.git')
    const source = join(root, 'src')
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', source])
    const git = simpleGit(source)
    await git.addConfig('user.email', 'b@elara.local')
    await git.addConfig('user.name', 'b')
    await writeFile(join(source, 'huge.txt'), randomBytes(4 * 1024 * 1024))
    await git.add('.')
    await git.commit('huge blob')
    commit = (await git.revparse(['HEAD'])).trim()
    execFileSync('git', ['init', '--bare', '--quiet', mirror])
    url = `file://${source}`
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('stops a fetch that outgrows its budget and keeps no ref to it', async () => {
    await expect(fetchQueryCommit(mirror, url, commit, { fetchBytes: 256 * 1024, timeoutMs: 60_000 })).rejects.toBeInstanceOf(MirrorReadLimitError)
    expect(await simpleGit(mirror).raw(['for-each-ref', 'refs/elara/'])).toBe('')
  })

  it('fetches the commit when it fits (into a fresh mirror: a rejected one is discarded by its caller)', async () => {
    await rm(mirror, { recursive: true, force: true })
    execFileSync('git', ['init', '--bare', '--quiet', mirror])
    await fetchQueryCommit(mirror, url, commit, { fetchBytes: 64 * 1024 * 1024, timeoutMs: 60_000 })
    expect((await simpleGit(mirror).revparse(['refs/elara/query'])).trim()).toBe(commit)
    expect(await mirrorBytes(mirror)).toBeGreaterThan(1024 * 1024)
  })
})
