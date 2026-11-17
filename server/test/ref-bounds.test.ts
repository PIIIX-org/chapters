import { describe, expect, it } from 'vitest'
import { diffView } from '../src/mcp/ref-view.js'
import { BlockBudget, BlockBudgetError, codeBlocks } from '../src/repositories/code-blocks.js'
import { VIEW_BLOCK_BOUNDS, VIEW_OUTLINE_BOUNDS, declarationIndex, type RepositoryView, type ViewFile } from '../src/repositories/ref-index.js'
import { VIEW_GRAPH_LIMITS, scoreDefinitions, viewQueries } from '../src/repositories/ref-queries.js'
import { noteBlocks } from '../src/notes/note-blocks.js'
import { outlineSections } from '../src/repositories/outline.js'
import { headings } from '../src/text/blocks.js'
import { lineStarts } from '../src/text/lines.js'
import { isTestPath } from '../src/repositories/code-edges.js'
import type { Definition } from '../src/repositories/code-queries.js'
import type { ExtractedSymbol } from '../src/repositories/extraction.js'

// #676 security review: what a repository reader can make a ref view cost.

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



describe('outline bounds in views', () => {
  const charged = () => {
    const state = { bytes: 0 }
    return { state, limits: { ...VIEW_OUTLINE_BOUNDS, charge: (n: number) => { state.bytes += n } } }
  }

  it('leaves ordinary documents identical to the live outline', () => {
    const content = '# Guide\ntext\n## Install\nmore\n### Linux\nx\n## Use\ny\n# Appendix\nz\n'
    expect(outlineSections('markdown', content, charged().limits)).toEqual(outlineSections('markdown', content))
  })

  it('cuts a 100,000-character title and charges every section before building its path', () => {
    const content = `# ${'T'.repeat(100_000)}\n` + Array.from({ length: 8_000 }, (_, i) => `## s${i}\n`).join('')
    const { state, limits } = charged()
    const heapBefore = process.memoryUsage().heapUsed
    const sections = outlineSections('markdown', content, limits)
    expect(sections).toHaveLength(8_001)
    expect(Math.max(...sections.map((s) => s.innerPath.length))).toBeLessThanOrEqual(VIEW_OUTLINE_BOUNDS.path)
    expect(sections[1]!.innerPath.startsWith('T'.repeat(200) + ' > s0')).toBe(true)
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 1024 * 1024)
    // 8,001 sections, each charged at least its path plus the per-section overhead.
    expect(state.bytes).toBeGreaterThan(sections.reduce((n, s) => n + s.innerPath.length, 0))
    // The live outline keeps the whole title (an ordinary document is unaffected; this one is not ordinary).
    expect(outlineSections('markdown', '# ' + 'T'.repeat(5_000) + '\n')[0]!.innerPath).toHaveLength(5_000)
  })

  it('refuses the request when the charge throws, before the path of that section exists, and skips an outline over its section cap', () => {
    const content = Array.from({ length: 50 }, (_, i) => `# h${i}\n`).join('')
    let calls = 0
    expect(() => outlineSections('markdown', content, { ...VIEW_OUTLINE_BOUNDS, charge: () => { if (++calls === 10) throw new BlockBudgetError('over') } })).toThrow(BlockBudgetError)
    expect(calls).toBe(10)
    expect(outlineSections('markdown', content, { ...VIEW_OUTLINE_BOUNDS, sections: 49, charge: () => undefined })).toEqual([])
  })
})

describe('block estimator', () => {
  const MIB = 1024 * 1024
  it('counts qualified names: 950-character class names x 9,000 methods x 4 files exceed 32 MiB and the request is refused', () => {
    const klass = 'C'.repeat(950)
    const content = `class ${klass} {\n` + Array.from({ length: 9_000 }, (_, i) => `  m${i}() {}\n`).join('') + '}\n'
    const symbols: ExtractedSymbol[] = [{ name: klass, kind: 'class', startLine: 1, endLine: 9_002, exported: true } as ExtractedSymbol, ...Array.from({ length: 9_000 }, (_, i) => ({ name: `m${i}`, parent: klass, kind: 'method', startLine: i + 2, endLine: i + 2, exported: false }) as ExtractedSymbol)]
    const budget = new BlockBudget({ bytes: 32 * MIB, blocks: 50_000 })
    let built = 0
    expect(() => { for (let i = 0; i < 4; i++) { codeBlocks(`f${i}`, `src/f${i}.ts`, content, symbols, [], { ...VIEW_BLOCK_BOUNDS, budget }); built++ } }).toThrow(BlockBudgetError)
    expect(built).toBeLessThan(4)
    // What one file really built is below what was charged for it.
    const one = new BlockBudget({ bytes: 1e10, blocks: 1e6 })
    const blocks = codeBlocks('f', 'src/f.ts', content, symbols, [], { ...VIEW_BLOCK_BOUNDS, budget: one })
    const real = blocks.reduce((n, b) => n + Buffer.byteLength(b.embedText) + Buffer.byteLength(b.innerPath) + Buffer.byteLength(b.snippet ?? ''), 0)
    expect(1e10 - one.bytes).toBeGreaterThanOrEqual(real)
  })

  it('counts multibyte text at its UTF-8 size', () => {
    const content = Array.from({ length: 200 }, (_, i) => `export function ${'é'.repeat(300)}${i}() {}`).join('\n') + '\n'
    const symbols = Array.from({ length: 200 }, (_, i) => symbol('é'.repeat(300) + i, i + 1))
    const budget = new BlockBudget({ bytes: 1e10, blocks: 1e6 })
    const blocks = codeBlocks('f', 'src/u.ts', content, symbols, [], { ...VIEW_BLOCK_BOUNDS, budget })
    expect(1e10 - budget.bytes).toBeGreaterThanOrEqual(blocks.reduce((n, b) => n + Buffer.byteLength(b.embedText) + Buffer.byteLength(b.innerPath) + Buffer.byteLength(b.snippet ?? ''), 0))
  })
})

describe('methods of same-named classes', () => {
  it('gives each of 9,000 `class C { m(){} }` its own method, in bounded time and memory', () => {
    const lines = Array.from({ length: 9_000 }, (_, i) => `class C { m() { return ${i} } }`)
    const content = lines.join('\n') + '\n'
    const symbols: ExtractedSymbol[] = lines.flatMap((_, i) => [
      { name: 'C', kind: 'class', startLine: i + 1, endLine: i + 1, exported: false } as ExtractedSymbol,
      { name: 'm', parent: 'C', kind: 'method', startLine: i + 1, endLine: i + 1, exported: false } as ExtractedSymbol,
    ])
    const budget = new BlockBudget({ bytes: 1e10, blocks: 1e6 })
    const heap = process.memoryUsage().heapUsed
    const started = performance.now()
    const blocks = codeBlocks('f', 'src/c.ts', content, symbols, [], { ...VIEW_BLOCK_BOUNDS, budget })
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(256 * 1024 * 1024)
    const classSkeletons = blocks.filter((b) => b.kind === 'skeleton' && b.outlineOf !== undefined)
    expect(classSkeletons).toHaveLength(9_000)
    // A class's skeleton holds its header and the lines inside its own range (shared skeleton allowance permitting), never every class's methods.
    for (const b of classSkeletons.slice(0, 5)) expect(b.embedText.split('\n').length).toBeLessThanOrEqual(3)
  })

  it('keeps the by-name grouping of the live index when no bounds are given, and for one class of a name', () => {
    const content = Array.from({ length: 400 }, (_, i) => `// ${i}`).join('\n') + '\n'
    const symbols = [
      { name: 'Repo', kind: 'class', startLine: 1, endLine: 2, exported: true },
      { name: 'save', parent: 'Repo', kind: 'method', startLine: 350, endLine: 351, exported: false },
    ] as ExtractedSymbol[]
    for (const bounds of [undefined, { ...VIEW_BLOCK_BOUNDS, budget: new BlockBudget({ bytes: 1e9, blocks: 1e6 }) }]) {
      const skeleton = codeBlocks('f', 'src/r.ts', content, symbols, [], bounds).find((b) => b.outlineOf !== undefined)
      expect(skeleton?.embedText.split('\n')).toHaveLength(3)
    }
  })
})

describe('diff of many binary changes', () => {
  it('looks skip reasons up in a map: 20,000 changed binary files diff in bounded time', () => {
    const entry = (path: string, sha: string) => [path, { path, type: 'blob', mode: '100644', sha, size: 3 }] as const
    const paths = Array.from({ length: 20_000 }, (_, i) => `bin/f${i}.dat`)
    const side = (sha: string): RepositoryView => ({ repositoryId: 'r', source: 's', tree: sha, files: new Map(), entries: new Map(paths.map((p) => entry(p, sha.repeat(40)))), skipped: paths.map((path) => ({ path, reason: 'binary' as const })), bytes: 0 })
    const started = performance.now()
    const answer = diffView(side('a'), side('b'), undefined)
    expect(performance.now() - started).toBeLessThan(5_000)
    const metadata = answer.sections.find((s) => s.name === 'metadata')
    expect(metadata && 'items' in metadata ? metadata.items : []).toHaveLength(20_000)
  })
})

describe('note blocks (live path)', () => {
  /** The section ends the forward `findIndex` scan produced, from the headings alone. */
  function scannedEnds(content: string) {
    const starts = lineStarts(content)
    const found = headings(content).map((h) => ({ level: h.level, line: starts.findIndex((o) => o === h.start) + 1 }))
    return found.map((h, i) => {
      const next = found.findIndex((o, j) => j > i && o.level <= h.level)
      return next === -1 ? starts.length : found[next]!.line - 1
    })
  }

  it('ends each section at the next heading of its level or above, as the scan did, and in linear time', () => {
    const levels = [1, 2, 3, 2, 2, 4, 1, 3, 3, 2, 6, 5, 1, 1, 2, 4, 4, 3, 1]
    const content = levels.map((level, i) => `${'#'.repeat(level)} T${i}\ntext ${i}\n`).join('')
    const sections = noteBlocks('n', 'a.md', content).filter((b) => b.kind === 'section')
    expect(sections.map((b) => b.endLine)).toEqual(scannedEnds(content))
    const flat = Array.from({ length: 40_000 }, (_, i) => `# h${i}`).join('\n') + '\n'
    const started = performance.now()
    noteBlocks('n', 'a.md', flat)
    expect(performance.now() - started).toBeLessThan(10_000)
  })
})
