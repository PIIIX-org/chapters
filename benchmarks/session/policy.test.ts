import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAPS } from '../lib/policies.ts'
import { comparable, expandAnswer, focusEntries, outlineEntries, questionTerms, runReread, sessionTools, shownRanges, withNeighbours, type ReadArgs } from './policy.ts'

test('sessionTools: session_id on every read_file in session mode, never on search, nowhere without a session', async () => {
  const seen: Array<[string, Record<string, unknown>]> = []
  const call = async (tool: string, args: Record<string, unknown>) => {
    seen.push([tool, args])
    return { text: '{}', ms: 1, ok: true }
  }
  for (const id of [null, 'bench-suite-1']) {
    const tools = sessionTools(call, 'repo', 10, id)
    await tools.search('q')
    await tools.readFile({ path: 'a.ts', outline: true })
    await tools.readFile({ path: 'a.ts', targets: [{ lines: '1-2' }] })
  }
  assert.deepEqual(seen, [
    ['search', { query: 'q', repositoryId: 'repo', limit: 10 }],
    ['read_file', { repositoryId: 'repo', path: 'a.ts', outline: true }],
    ['read_file', { repositoryId: 'repo', path: 'a.ts', targets: [{ lines: '1-2' }] }],
    ['search', { query: 'q', repositoryId: 'repo', limit: 10 }],
    ['read_file', { repositoryId: 'repo', path: 'a.ts', outline: true, session_id: 'bench-suite-1' }],
    ['read_file', { repositoryId: 'repo', path: 'a.ts', targets: [{ lines: '1-2' }], session_id: 'bench-suite-1' }],
  ])
})

const ENTRIES = [
  { name: 'Store', start: 1, end: 30 },
  { name: 'Store.load', start: 3, end: 10 },
  { name: 'Store.save', start: 12, end: 20 },
  { name: 'Store.close', start: 22, end: 28 },
  { name: 'rateLimit', start: 32, end: 40 },
]

test('focusEntries: the smallest entry holding each symbol hit, else the entries naming the most question words', () => {
  assert.deepEqual(focusEntries(ENTRIES, [{ path: 'a.ts', start: 13, end: 14 }], []), [ENTRIES[2]])
  assert.deepEqual(focusEntries(ENTRIES, [], questionTerms('Where is the rate limit (rateLimit) enforced?')), [ENTRIES[4]])
  assert.deepEqual(focusEntries(ENTRIES, [], questionTerms('how does it work')), [])
  assert.deepEqual(questionTerms('Which file decides whether the `rea` executable starts?'), ['decides', 'whether', 'executable', 'starts'])
})

test('withNeighbours: each focus entry with the closest section above and the first below, in document order', () => {
  assert.deepEqual(withNeighbours(ENTRIES, [ENTRIES[2]!]), [ENTRIES[1], ENTRIES[2], ENTRIES[3]])
  // The class that holds the focus is not its neighbour; above a top-level entry is the previous top-level one; the last entry has nothing below.
  assert.deepEqual(withNeighbours(ENTRIES, [ENTRIES[4]!]), [ENTRIES[0], ENTRIES[4]])
})

test('outlineEntries reads objects and location strings; shownRanges counts text and references', () => {
  assert.deepEqual(outlineEntries({ outline: [{ symbol: 'A', kind: 'function', lines: [1, 4], tokens: 9 }, 'B#L6-L8', { heading: 'H', lines: [10, 12] }] }), [
    { name: 'A', start: 1, end: 4 },
    { name: 'B', start: 6, end: 8 },
    { name: 'H', start: 10, end: 12 },
  ])
  assert.deepEqual(outlineEntries({ outline: { function: 3 } }), [])
  const answer = {
    targets: [
      { lines: [1, 3], text: 'a\nb\nc\n' },
      // Split by the page: the last line is not whole.
      { lines: [5, 7], text: 'e\nf\ng', next: '7-9' },
      { lines: [10, 12], same_as: { call: 1, loc: 'a.ts#L10-L12', hash: 'h' } },
      { lines: [20, 22], next: '20-22' },
    ],
  }
  assert.deepEqual(shownRanges('a.ts', answer), [
    { path: 'a.ts', start: 1, end: 3 },
    { path: 'a.ts', start: 5, end: 6 },
    { path: 'a.ts', start: 10, end: 12 },
  ])
  assert.deepEqual(shownRanges('a.ts', { content: { same_as: { call: 2, loc: 'a.ts#L1-L40', hash: 'h' } } }), [{ path: 'a.ts', start: 1, end: 40 }])
})

test('expandAnswer puts referenced text, outline and content back and drops `call`', () => {
  const sent = new Map<number, unknown>([
    [1, { call: 1, path: 'a.ts', content: 'l1\nl2\nl3\nl4\n', symbols: [{ path: 'f', lines: [1, 2] }] }],
    [2, { call: 2, path: 'a.ts', outline: [{ symbol: 'f', lines: [1, 2] }] }],
  ])
  const plain = { path: 'a.ts', targets: [{ lines: [2, 3], text: 'l2\nl3\n' }, { lines: [4, 4], text: 'l4\n' }], truncated: false }
  const session = {
    call: 3,
    path: 'a.ts',
    targets: [{ lines: [2, 3], same_as: { call: 1, loc: 'a.ts#L2-L3', hash: 'h' } }, { lines: [4, 4], text: 'l4\n' }],
    truncated: false,
  }
  assert.equal(comparable(expandAnswer(session, sent)), comparable(plain))
  assert.deepEqual(expandAnswer({ call: 4, outline: { same_as: { call: 2, loc: 'a.ts', hash: 'h' } } }, sent), { outline: [{ symbol: 'f', lines: [1, 2] }] })
  assert.deepEqual(expandAnswer({ call: 5, content: { same_as: { call: 1, loc: 'a.ts#L1-L4', hash: 'h' } } }, sent), { content: 'l1\nl2\nl3\nl4\n' })
  // A reference to a call the session never got cannot be expanded.
  assert.equal(expandAnswer({ call: 6, content: { same_as: { call: 9, loc: 'a.ts#L1-L4', hash: 'h' } } }, sent), null)
  // Cursors differ by the referenced sections they carry.
  assert.equal(comparable({ truncated: { cursor: 'abc' } }), comparable({ truncated: { cursor: 'xyz' } }))
})

/** A file of 40 lines, `line N` each. */
const FILE = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join('')
const lines = (a: number, b: number) => FILE.split(/(?<=\n)/).slice(a - 1, b).join('')

test('runReread: search, outline, focus, focus with neighbours per file; a file without a focus is read whole; references count as seen', async () => {
  const calls: string[] = []
  // A symbol hit in a.ts at Store.save; b.ts is a code hit, and no entry of it names a question word.
  const hits = [
    { path: 'a.ts', resourceType: 'symbol', startLine: 12, endLine: 20, snippet: 'line 12' },
    { path: 'b.ts', resourceType: 'code', snippet: 'x' },
  ]
  const outline = { outline: ENTRIES.map((e) => ({ symbol: e.name, lines: [e.start, e.end], tokens: 1 })) }
  const tools = {
    async search(query: string) {
      calls.push(`search ${query}`)
      return { text: JSON.stringify({ status: 'ok', results: hits }), ms: 1, ok: true }
    },
    async readFile(args: ReadArgs) {
      calls.push(`read_file ${JSON.stringify(args)}`)
      if (args.outline) return { text: JSON.stringify(args.path === 'a.ts' ? outline : { outline: [{ symbol: 'other', lines: [1, 5] }] }), ms: 1, ok: true }
      if (!args.targets) return { text: JSON.stringify({ path: args.path, content: FILE }), ms: 1, ok: true }
      // The second read of Store.save answers it by reference, as a session does.
      const repeat = calls.filter((c) => c.includes('"12-20"')).length > 1
      const targets = args.targets.map((t) => {
        const [a, b] = t.lines.split('-').map(Number) as [number, number]
        return repeat && a === 12 ? { lines: [a, b], same_as: { call: 2, loc: `a.ts#L${a}-L${b}`, hash: 'h' } } : { lines: [a, b], text: lines(a, b) }
      })
      return { text: JSON.stringify({ path: args.path, targets }), ms: 1, ok: true }
    },
  }
  // The gold is Store.close: only the neighbours read reaches it.
  const run = await runReread('where are files saved', [{ path: 'a.ts', start: 23, end: 24 }], tools)
  assert.deepEqual(calls, [
    'search where are files saved',
    'read_file {"path":"a.ts","outline":true}',
    'read_file {"path":"a.ts","targets":[{"lines":"12-20"}]}',
    'read_file {"path":"a.ts","targets":[{"lines":"3-10"},{"lines":"12-20"},{"lines":"22-28"}]}',
    'read_file {"path":"b.ts","outline":true}',
    'read_file {"path":"b.ts"}',
  ])
  assert.deepEqual(run.ranking, ['a.ts', 'b.ts'])
  assert.equal(run.episode.callsToGold, 4)
  assert.ok(run.episode.seen.covers({ path: 'a.ts', start: 12, end: 20 }))
  assert.ok(run.episode.seen.covers({ path: 'b.ts', start: 1, end: 40 }))
  assert.equal(run.answers.length, 6)
  assert.deepEqual(
    run.answers.map((a) => a.tool),
    ['search', 'read_file', 'read_file', 'read_file', 'read_file', 'read_file'],
  )
})

test('runReread stops at the call cap', async () => {
  const tools = {
    search: async () => ({ text: JSON.stringify({ status: 'ok', results: ['a.ts', 'b.ts', 'c.ts'] }), ms: 1, ok: true }),
    readFile: async (args: ReadArgs) => ({ text: JSON.stringify({ path: args.path, content: FILE }), ms: 1, ok: true }),
  }
  const run = await runReread('q', [{ path: 'z.ts', start: 1, end: 1 }], tools, { ...CAPS, maxCalls: 3 })
  assert.equal(run.episode.trace.length, 3)
  assert.equal(run.episode.tokensToGold, null)
})
