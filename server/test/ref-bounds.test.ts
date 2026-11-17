import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { BlockBudget, BlockBudgetError, codeBlocks } from '../src/repositories/code-blocks.js'
import { VIEW_BLOCK_BOUNDS, declarationIndex, type ViewFile } from '../src/repositories/ref-index.js'
import { VIEW_GRAPH_LIMITS, scoreDefinitions, viewQueries } from '../src/repositories/ref-queries.js'
import { MirrorReadLimitError, fetchQueryCommit, listRemoteCapped, mirrorBytes } from '../src/repositories/git-mirror.js'
import { admitRefFetch, REF_FETCH_ADMISSION, RefFetchRefused, resetRefFetchAdmission } from '../src/repositories/ref-fetch-admission.js'
import { outlineSections } from '../src/repositories/outline.js'
import { headings } from '../src/text/blocks.js'
import { lineStarts } from '../src/text/lines.js'
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

describe('outline sections', () => {
  /** The implementation this replaced: a forward scan for each heading's next heading of the same or a higher level. */
  function scanned(content: string) {
    const starts = lineStarts(content)
    const lineOf = (offset: number) => starts.filter((start) => start <= offset).length
    const found = headings(content).map((h) => ({ level: h.level, title: h.title, line: lineOf(h.start) }))
    const total = starts.length
    const trail: typeof found = []
    return found.map((h, i) => {
      while (trail.length > 0 && trail.at(-1)!.level >= h.level) trail.pop()
      trail.push(h)
      const next = found.findIndex((o, j) => j > i && o.level <= h.level)
      const before = (line: number | undefined) => Math.max(h.line, line === undefined ? total : line - 1)
      return { innerPath: trail.map((t) => t.title).join(' > '), startLine: h.line, ownEndLine: before(found[i + 1]?.line), endLine: before(next === -1 ? undefined : found[next]!.line) }
    })
  }

  it('matches the forward scan on nested, skipped-level and repeated headings', () => {
    const levels = [1, 2, 3, 2, 2, 4, 1, 3, 3, 2, 6, 5, 1, 1, 2, 4, 4, 3, 1]
    const content = levels.map((level, i) => `${'#'.repeat(level)} Title ${i}\ntext ${i}\n`).join('\n')
    const sections = outlineSections('markdown', content)
    expect(sections).toHaveLength(levels.length)
    expect(sections).toEqual(scanned(content))
  })

  it('outlines 40,000 flat headings, and a deep alternating tree, in linear time', () => {
    const flat = Array.from({ length: 40_000 }, (_, i) => `# h${i}`).join('\n') + '\n'
    const started = performance.now()
    expect(outlineSections('markdown', flat)).toHaveLength(40_000)
    const alternating = Array.from({ length: 40_000 }, (_, i) => `${'#'.repeat(1 + (i % 6))} h${i}`).join('\n') + '\n'
    expect(outlineSections('markdown', alternating)).toHaveLength(40_000)
    expect(performance.now() - started).toBeLessThan(3_000)
  })
})

describe('declaration lookup', () => {
  it('finds each of 30,000 declarations by line and inner path through one map, the first of a duplicate winning', () => {
    const symbols = Array.from({ length: 30_000 }, (_, i) => symbol(`f${i}`, i + 1))
    symbols.push({ ...symbol('f0', 1), endLine: 99 })
    const file = { structure: { symbols, imports: [], sites: [] } } as unknown as ViewFile
    const started = performance.now()
    const index = declarationIndex(file)
    for (let i = 0; i < 30_000; i++) expect(index.get(`${i + 1}\0f${i}`)?.name).toBe(`f${i}`)
    expect(index.get('1\0f0')?.endLine).toBe(1)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(declarationIndex(file)).toBe(index)
  })
})

describe('view call graph resolution', () => {
  const site = (line: number) => ({ kind: 'call' as const, line, col: 1, name: 'dup', qualified: null, via: null, member: false, enclosing: null, local: null })
  /** 1,000 headers each defining `dup`, and one C file that includes all of them and calls `dup` 1,000 times. */
  function cView() {
    const files = new Map<string, ViewFile>()
    const make = (path: string, content: string, symbols: ExtractedSymbol[], imports: Array<{ target: string; line: number }>, sites: ReturnType<typeof site>[]) => {
      const id = `id-${path}`
      files.set(path, { id, path, content, contentHash: path, language: 'c', size: content.length, structure: { symbols, imports, sites }, blocks: codeBlocks(id, path, content, symbols) } as unknown as ViewFile)
    }
    for (let i = 0; i < 1000; i++) make(`h${i}.h`, 'void dup(void) {}\n', [symbol('dup', 1)], [], [])
    make('main.c', 'dup();\n'.repeat(1000), [], Array.from({ length: 1000 }, (_, i) => ({ target: `h${i}.h`, line: 1 })), Array.from({ length: 1000 }, (_, i) => site(i + 1)))
    return { repositoryId: 'r', source: 's', tree: `t${Math.random()}`, files, skipped: [], bytes: 0 }
  }

  it('resolves 1,000 calls over 1,000 imports and 1,000 same-named definitions without a scan per candidate', () => {
    const limit = VIEW_GRAPH_LIMITS.resolveWork
    try {
      VIEW_GRAPH_LIMITS.resolveWork = 5_000_000
      const started = performance.now()
      viewQueries(cView())
      expect(performance.now() - started).toBeLessThan(3_000)
    } finally { VIEW_GRAPH_LIMITS.resolveWork = limit }
  })

  it('charges every pass over the candidates, so the same view is refused under a smaller budget', () => {
    const limit = VIEW_GRAPH_LIMITS.resolveWork
    try {
      VIEW_GRAPH_LIMITS.resolveWork = 1_000_000
      expect(() => viewQueries(cView())).toThrow(/too large to resolve/)
    } finally { VIEW_GRAPH_LIMITS.resolveWork = limit }
  })
})

describe('generated block budget', () => {
  const dense = () => {
    const lines = Array.from({ length: 150 }, (_, row) => Array.from({ length: 30 }, (_, k) => `function d${row}_${k}(){}`).join(';').padEnd(900, ' '))
    return { content: lines.join('\n') + '\n', symbols: lines.flatMap((_, row) => Array.from({ length: 30 }, (_, k) => symbol(`d${row}_${k}`, row + 1))) }
  }
  const actual = (blocks: ReturnType<typeof codeBlocks>) => blocks.reduce((n, b) => n + b.embedText.length + (b.snippet?.length ?? 0), 0)

  it('charges at least what the blocks it allows hold, for ordinary and dense files', () => {
    const ordinary = Array.from({ length: 400 }, (_, i) => `export function f${i}() { return ${i} }`).join('\n') + '\n'
    for (const [content, symbols] of [[ordinary, Array.from({ length: 400 }, (_, i) => symbol(`f${i}`, i + 1))], [dense().content, dense().symbols]] as const) {
      const budget = new BlockBudget({ bytes: 1e9, blocks: 1e6 })
      const blocks = codeBlocks('f', 'src/a.ts', content, symbols, [], { ...VIEW_BLOCK_BOUNDS, budget })
      expect(1e9 - budget.bytes).toBeGreaterThanOrEqual(actual(blocks))
      expect(1e6 - budget.blocks).toBeGreaterThanOrEqual(blocks.length)
    }
  })

  it('refuses a file that does not fit before it builds any block, and leaves the allowance to the next', () => {
    const { content, symbols } = dense()
    const budget = new BlockBudget({ bytes: 1024 * 1024, blocks: 100_000 })
    expect(() => codeBlocks('f', 'src/dense.ts', content, symbols, [], { ...VIEW_BLOCK_BOUNDS, budget })).toThrow(BlockBudgetError)
    expect(budget.bytes).toBe(1024 * 1024)
    expect(() => codeBlocks('f', 'src/dense.ts', content, symbols, [], { ...VIEW_BLOCK_BOUNDS, budget: new BlockBudget({ bytes: 1e9, blocks: 100 }) })).toThrow(/100 blocks/)
  })
})

describe('ref fetch admission', () => {
  const MB = 1024 * 1024
  const env = { account: process.env.ELARA_REF_FETCH_ACCOUNT_MB, instance: process.env.ELARA_REF_FETCH_INSTANCE_MB }
  let now = 0
  beforeEach(() => {
    now = 1_000_000
    resetRefFetchAdmission(() => now)
    process.env.ELARA_REF_FETCH_ACCOUNT_MB = '300'
    process.env.ELARA_REF_FETCH_INSTANCE_MB = '4096'
  })
  afterEach(() => {
    for (const [key, value] of [['ELARA_REF_FETCH_ACCOUNT_MB', env.account], ['ELARA_REF_FETCH_INSTANCE_MB', env.instance]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetRefFetchAdmission()
  })

  it('refuses a third concurrent fetch without queueing and admits it once one ends', () => {
    process.env.ELARA_REF_FETCH_ACCOUNT_MB = '4096'
    const a = admitRefFetch('a', 256 * MB)
    admitRefFetch('b', 256 * MB)
    expect(REF_FETCH_ADMISSION.maxConcurrent).toBe(2)
    expect(() => admitRefFetch('c', 256 * MB)).toThrow(/another ref fetch is running/)
    a.settle(0)
    expect(() => admitRefFetch('c', 256 * MB)).not.toThrow()
  })

  it('gives an account its hourly allowance, refunds the unused part, and refills over time', () => {
    const first = admitRefFetch('a', 256 * MB)
    first.settle(10 * MB)
    // 300 MiB allowance: 256 reserved, 246 refunded -> 290 left, enough again.
    const second = admitRefFetch('a', 256 * MB)
    expect(() => admitRefFetch('a', 256 * MB)).toThrow(RefFetchRefused)
    second.settle(256 * MB)
    expect(() => admitRefFetch('a', 256 * MB)).toThrow(/allowance \(300 MiB per hour\)/)
    // 300 MiB per hour: 222 MiB are missing, 2,664 s.
    now += 2_000 * 1000
    expect(() => admitRefFetch('a', 256 * MB)).toThrow(RefFetchRefused)
    now += 700 * 1000
    expect(() => admitRefFetch('a', 256 * MB)).not.toThrow()
    // Another account is unaffected.
    expect(() => admitRefFetch('b', 256 * MB)).not.toThrow()
  })

  it('debits an overshoot and refuses on the instance allowance across accounts', () => {
    const over = admitRefFetch('a', 256 * MB)
    over.settle(400 * MB)
    expect(() => admitRefFetch('a', 1 * MB)).toThrow(RefFetchRefused)
    resetRefFetchAdmission(() => now)
    process.env.ELARA_REF_FETCH_ACCOUNT_MB = '4096'
    process.env.ELARA_REF_FETCH_INSTANCE_MB = '300'
    admitRefFetch('a', 256 * MB).settle(0)
    const held = admitRefFetch('a', 256 * MB)
    expect(() => admitRefFetch('b', 256 * MB)).toThrow(/instance's ref fetch allowance/)
    held.settle(0)
    expect(() => admitRefFetch('b', 256 * MB)).not.toThrow()
  })
})

describe('bounded remote lookups and fetches', () => {
  let root: string
  let source: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elara-remote-'))
    source = join(root, 'src')
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', source])
    const git = simpleGit(source)
    await git.addConfig('user.email', 'b@elara.local')
    await git.addConfig('user.name', 'b')
    await writeFile(join(source, 'a.txt'), 'a\n')
    await git.add('.')
    await git.commit('one')
    const head = (await git.revparse(['HEAD'])).trim()
    execFileSync('git', ['update-ref', '--stdin'], { cwd: source, input: Array.from({ length: 3_000 }, (_, i) => `create refs/heads/many/branch-number-${i} ${head}\n`).join('') })
    await writeFile(join(source, 'blob.bin'), randomBytes(4 * 1024 * 1024))
    await git.add('.')
    await git.commit('blob')
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('refuses an advertisement over the byte cap, killing git, and returns a small one whole', async () => {
    await expect(listRemoteCapped(`file://${source}`, ['refs/heads/many/*'], 4 * 1024)).rejects.toBeInstanceOf(MirrorReadLimitError)
    await expect(listRemoteCapped(`file://${source}`, ['refs/heads/many/*'], 4 * 1024)).rejects.not.toThrow(source)
    const rows = (await listRemoteCapped(`file://${source}`, ['refs/heads/many/*'])).trim().split('\n')
    expect(rows).toHaveLength(3_000)
  })

  it.skipIf(process.platform === 'win32')('stops a fetch at the pack-file size limit even when the poll never runs', async () => {
    const commit = (await simpleGit(source).revparse(['HEAD'])).trim()
    const mirror = join(root, 'hard.git')
    execFileSync('git', ['init', '--bare', '--quiet', mirror])
    await expect(fetchQueryCommit(mirror, `file://${source}`, commit, { fetchBytes: 512 * 1024, timeoutMs: 60_000, pollMs: 3_600_000 })).rejects.toBeInstanceOf(MirrorReadLimitError)
    // One file cannot grow past the limit (twice it, in shells that count 1,024-byte blocks).
    expect(await mirrorBytes(mirror)).toBeLessThan(2 * 512 * 1024 + 256 * 1024)
  })
})
