import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAPS, Episode, GREP, missCost, readingOrder, runElara, runGrep, visibleContentLines, type ElaraTools, type GrepTools } from './policies.ts'

test('readingOrder keeps the server order and breaks exact score ties by path', () => {
  const hits = [
    { path: 'b.ts', score: 0.03 },
    { path: 'z.ts', score: 0.02 },
    { path: 'a.ts', score: 0.02 },
    { path: 'c.ts', score: 0.01 },
    { path: 'y.ts' },
    { path: 'x.ts' },
  ]
  // Hits without a score are not ties: they keep their place.
  assert.deepEqual(readingOrder(hits).map((h) => h.path), ['b.ts', 'a.ts', 'z.ts', 'c.ts', 'y.ts', 'x.ts'])
})

/** A fake repository: path -> content. */
const FILES: Record<string, string> = {
  'src/a.ts': Array.from({ length: 100 }, (_, i) => `a line ${i + 1}`).join('\n'),
  'src/b.ts': Array.from({ length: 60 }, (_, i) => (i + 1 === 40 ? 'export function target() {' : `b line ${i + 1}`)).join('\n'),
  'src/c.ts': 'one\ntwo\nthree',
}

function fakeElara(hits: unknown[], calls: string[]): ElaraTools {
  return {
    async search(query) {
      calls.push(`search ${query}`)
      return { text: JSON.stringify(hits), ms: 5, ok: true }
    },
    async readFile(path) {
      calls.push(`read_file ${path}`)
      const content = FILES[path]
      if (content === undefined) return { text: 'Error: file not found', ms: 1, ok: false }
      return { text: JSON.stringify({ path, language: 'typescript', content, symbols: [] }), ms: 7, ok: true }
    },
  }
}

test('elara: reads hits best first and stops once the gold is covered', async () => {
  const calls: string[] = []
  const hits = [
    { resourceType: 'code', path: 'src/a.ts', snippet: 'x' },
    { resourceType: 'symbol', path: 'src/a.ts', startLine: 1, endLine: 3, snippet: 'a line 1\na line 2\na line 3' },
    { resourceType: 'code', path: 'src/b.ts', snippet: 'y' },
    { resourceType: 'code', path: 'src/c.ts', snippet: 'z' },
  ]
  const run = await runElara('where is target', [{ path: 'src/b.ts', start: 40, end: 40 }], fakeElara(hits, calls))
  assert.deepEqual(run.ranking, ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  assert.deepEqual(calls, ['search where is target', 'read_file src/a.ts', 'read_file src/b.ts'])
  const ep = run.episode
  assert.equal(ep.callsToGold, 3)
  const searchTokens = Math.ceil(JSON.stringify(hits).length / 4)
  assert.equal(ep.trace[0]!.tokens, searchTokens)
  assert.equal(ep.tokensToGold, ep.tokens)
  assert.equal(ep.tokensToAllGold, ep.tokens)
  // Whole files are in context: 100 + 60 lines.
  assert.equal(ep.seen.size, 160)
})

test('elara: a symbol hit whose snippet shows the gold reaches it without a read', async () => {
  const calls: string[] = []
  const hits = [{ resourceType: 'symbol', path: 'src/b.ts', startLine: 40, endLine: 55, snippet: 'export function target() {\n  body' }]
  const run = await runElara('target', [{ path: 'src/b.ts', start: 40, end: 41 }], fakeElara(hits, calls))
  assert.deepEqual(calls, ['search target'])
  assert.equal(run.episode.callsToGold, 1)
  // Only the two snippet lines were shown, not the whole 40-55 range.
  assert.equal(run.episode.seen.size, 2)
})

test('elara: a miss stops at the file cap and records no gold', async () => {
  const calls: string[] = []
  const hits = [{ resourceType: 'code', path: 'src/a.ts', snippet: '' }, { resourceType: 'code', path: 'missing.ts', snippet: '' }]
  const run = await runElara('q', [{ path: 'src/b.ts', start: 40, end: 40 }], fakeElara(hits, calls))
  assert.deepEqual(calls, ['search q', 'read_file src/a.ts', 'read_file missing.ts'])
  assert.equal(run.episode.tokensToGold, null)
  assert.equal(run.episode.callsToGold, null)
  assert.equal(run.episode.trace[2]!.ok, false)
})

test('elara: a failed search ends the episode with an empty ranking', async () => {
  const tools: ElaraTools = {
    async search() {
      return { text: 'HTTP 500: boom', ms: 1, ok: false }
    },
    async readFile() {
      throw new Error('must not read')
    },
  }
  const run = await runElara('q', [{ path: 'src/b.ts', start: 1, end: 1 }], tools)
  assert.deepEqual(run.ranking, [])
  assert.equal(run.episode.trace.length, 1)
})

test('elara: a response past perCallChars only shows the lines that fit', async () => {
  const content = Array.from({ length: 1000 }, (_, i) => `line ${i + 1} ${'x'.repeat(90)}`).join('\n')
  const tools: ElaraTools = {
    async search() {
      return { text: JSON.stringify([{ resourceType: 'code', path: 'big.ts', snippet: '' }]), ms: 1, ok: true }
    },
    async readFile(path) {
      return { text: JSON.stringify({ path, language: null, content, symbols: [] }), ms: 1, ok: true }
    },
  }
  const caps = { ...CAPS, perCallChars: 10_000 }
  const run = await runElara('q', [{ path: 'big.ts', start: 900, end: 900 }], tools, caps)
  const read = run.episode.trace[1]!
  assert.equal(read.truncated, true)
  assert.equal(read.tokens, 2_500)
  // ~100 lines of ~100 escaped characters fit in 10,000 characters.
  const shown = run.episode.seen.size
  assert.ok(shown > 90 && shown < 100, `shown ${shown}`)
  assert.equal(run.episode.tokensToGold, null)
})

test('elara: a paged read_file follows the cursor page by page and stops once the gold is seen', async () => {
  // 100 lines served ~30 per page, line 60 split across pages 2 and 3, as the server's budget does with an overlong line.
  const lines = Array.from({ length: 100 }, (_, i) => `p line ${i + 1}\n`)
  const pages = [lines.slice(0, 30).join(''), lines.slice(30, 59).join('') + 'p line', lines.slice(59, 90).join('').slice('p line'.length), lines.slice(90).join('')]
  const firsts = [1, 31, 60, 91]
  const calls: string[] = []
  const tools: ElaraTools = {
    async search() {
      return { text: JSON.stringify([{ resourceType: 'code', path: 'paged.ts', snippet: '' }]), ms: 1, ok: true }
    },
    async readFile(path, cursor) {
      calls.push(`read_file ${path} ${cursor ?? '-'}`)
      const n = cursor === undefined ? 0 : Number(cursor)
      const truncated = n === pages.length - 1 ? false : { shown: {}, total: {}, dropped: {}, level: 'full', cursor: String(n + 1), narrow: [] }
      return { text: JSON.stringify({ path, language: null, lines: [firsts[n], 0], content: pages[n], symbols: [], truncated }), ms: 1, ok: true }
    },
  }
  assert.equal(pages.join(''), lines.join(''))
  const run = await runElara('q', [{ path: 'paged.ts', start: 60, end: 62 }], tools)
  assert.deepEqual(calls, ['read_file paged.ts -', 'read_file paged.ts 1', 'read_file paged.ts 2'])
  assert.equal(run.episode.callsToGold, 4)
  // Lines 1-90 were completed in context; line 60 counts on page 3, where its end was shown.
  assert.equal(run.episode.seen.size, 90)
  assert.deepEqual(run.episode.trace.slice(1).map((t) => t.tool), ['read_file', 'read_file', 'read_file'])
})

test('visibleContentLines counts JSON-escaped characters', () => {
  const content = 'a"b\nline2\nline3'
  const response = JSON.stringify({ path: 'p', content })
  const head = response.indexOf('"content":"') + '"content":"'.length
  // Line 1 is `a\"b` (4 chars) + `\n` (2 chars).
  assert.equal(visibleContentLines(response, content, head + 5), 0)
  assert.equal(visibleContentLines(response, content, head + 6), 1)
  assert.equal(visibleContentLines(response, content, response.length), 3)
  assert.equal(visibleContentLines('Error', content, 100), 0)
})

function fakeGrep(calls: string[]): GrepTools {
  return {
    async count(patterns) {
      calls.push(`count ${patterns.join('|')}`)
      return {
        files: [
          { path: 'src/c.ts', count: 1 },
          { path: 'src/a.ts', count: 1 },
          { path: 'src/b.ts', count: 3 },
        ],
        ms: 2,
      }
    },
    async matches(_patterns, paths, perFile) {
      calls.push(`matches ${paths.join(',')} -m ${perFile}`)
      const byPath = new Map(
        paths.map((path) => [path, (path === 'src/b.ts' ? [5, 12, 70] : [2]).map((line) => ({ line, text: 'x'.repeat(300) }))]),
      )
      return { byPath, ms: 1 }
    },
    async read(path, start, end) {
      calls.push(`read ${path}:${start}-${end}`)
      const all = (FILES[path] ?? '').split('\n')
      return { lines: all.slice(start - 1, end), start, ms: 1 }
    },
  }
}

test('grep: ranks files by matching lines (ties by path), previews matches, reads windows around them', async () => {
  const calls: string[] = []
  const run = await runGrep(['target'], [{ path: 'src/b.ts', start: 40, end: 40 }], fakeGrep(calls))
  assert.deepEqual(run.ranking, ['src/b.ts', 'src/a.ts', 'src/c.ts'])
  // Match at 5 reads 1-35; 12 is inside that window; 70 reads 60-100 (the file has 60 lines);
  // two reads per file, then the next file.
  assert.deepEqual(calls, [
    'count target',
    `matches src/b.ts,src/a.ts,src/c.ts -m ${GREP.matchesPerFile}`,
    'read src/b.ts:1-35',
    'read src/b.ts:60-100',
    'read src/a.ts:1-32',
    'read src/c.ts:1-32',
  ])
  assert.equal(run.episode.tokensToGold, null)
  // The preview shows path:line:text, lines cut at GREP.lineChars characters, in ranking order.
  const cut = `${'x'.repeat(GREP.lineChars)} [...]`
  const shown = ['src/b.ts:5', 'src/b.ts:12', 'src/b.ts:70', 'src/a.ts:2', 'src/c.ts:2'].map((p) => `${p}:${cut}`).join('\n')
  assert.equal(run.episode.trace[1]!.tokens, Math.ceil(shown.length / 4))
})

test('grep: stops as soon as a ranged read covers the gold', async () => {
  const calls: string[] = []
  const run = await runGrep(['target'], [{ path: 'src/b.ts', start: 30, end: 31 }], fakeGrep(calls))
  assert.deepEqual(calls, ['count target', `matches src/b.ts,src/a.ts,src/c.ts -m ${GREP.matchesPerFile}`, 'read src/b.ts:1-35'])
  assert.equal(run.episode.callsToGold, 3)
  assert.equal(run.episode.tokensToGold, run.episode.tokens)
})

test('grep: a gold line shown by the rg -n preview needs no read', async () => {
  const calls: string[] = []
  const run = await runGrep(['target'], [{ path: 'src/a.ts', start: 2, end: 2 }], fakeGrep(calls))
  assert.equal(calls.length, 2)
  assert.equal(run.episode.callsToGold, 2)
})

test('grep: no match ends after the count call', async () => {
  const tools: GrepTools = {
    async count() {
      return { files: [], ms: 1 }
    },
    async matches() {
      throw new Error('must not run')
    },
    async read() {
      throw new Error('must not run')
    },
  }
  const run = await runGrep(['nothing'], [{ path: 'a', start: 1, end: 1 }], tools)
  assert.deepEqual(run.ranking, [])
  assert.equal(run.episode.trace.length, 1)
})

test('episode: stops at the call cap and the token budget', () => {
  const ep = new Episode([{ path: 'f', start: 1, end: 1 }], { ...CAPS, maxCalls: 2, tokenBudget: 10 })
  ep.record('t', '', 'abcd', false, 1, true, [])
  assert.equal(ep.done, false)
  ep.record('t', '', 'abcd', false, 1, true, [])
  assert.equal(ep.done, true) // 2 calls
  const budget = new Episode([{ path: 'f', start: 1, end: 1 }], { ...CAPS, tokenBudget: 10 })
  budget.record('t', '', 'x'.repeat(40), false, 1, true, [])
  assert.equal(budget.done, true) // 10 tokens
})

test('episode: first gold and all gold are tracked separately', () => {
  const ep = new Episode(
    [
      { path: 'f', start: 1, end: 2 },
      { path: 'g', start: 5, end: 5 },
    ],
    CAPS,
  )
  ep.record('t', '', 'abcd', false, 1, true, [{ path: 'f', start: 1, end: 1 }])
  assert.equal(ep.tokensToGold, null) // line 2 of the first range still missing
  ep.record('t', '', 'abcd', false, 1, true, [{ path: 'f', start: 2, end: 3 }])
  assert.equal(ep.tokensToGold, 2)
  assert.equal(ep.callsToGold, 2)
  assert.equal(ep.tokensToAllGold, null)
  ep.record('t', '', 'abcd', false, 1, true, [{ path: 'g', start: 1, end: 9 }])
  assert.equal(ep.tokensToAllGold, 3)
  assert.equal(ep.done, true)
})

test('the miss cost is at least what any episode can spend', () => {
  const m = missCost(CAPS)
  assert.equal(m.calls, CAPS.maxCalls)
  assert.ok(m.tokens >= CAPS.tokenBudget + CAPS.perCallChars / 4)
})
