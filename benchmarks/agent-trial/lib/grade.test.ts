import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { claimSentence, gradeAnswer, sentences } from './grade.ts'
import type { Task, TaskFile } from './tasks.ts'

const file = JSON.parse(readFileSync(new URL('../tasks.json', import.meta.url), 'utf8')) as TaskFile

const task: Task = {
  id: 'X',
  title: 'x',
  prompt: 'x',
  facts: [
    { id: 'X.1', fact: 'defined at store.ts:106', evidence: [{ path: 'a.ts', lines: '1', contains: 'a' }], patterns: ['store\\.ts', '\\b106\\b'], sample: 'store.ts:106' },
    { id: 'X.2', fact: 'RRF k=60', evidence: [{ path: 'a.ts', lines: '1', contains: 'a' }], patterns: ['RRF'], sample: 'RRF' },
    { id: 'X.3', fact: 'uses ILIKE', evidence: [{ path: 'a.ts', lines: '1', contains: 'a' }], patterns: ['ilike'], sample: 'ILIKE' },
  ],
  falseClaims: [
    { id: 'X.F1', claim: 'uses BM25', refutedBy: 'ts_rank', evidence: [{ path: 'a.ts', lines: '1', contains: 'a' }], patterns: ['BM25'], sample: 'It uses BM25.', refutation: 'It does not use BM25.' },
    {
      id: 'X.F2',
      claim: 'methods are not captured',
      refutedBy: 'python methods are',
      evidence: [{ path: 'a.ts', lines: '1', contains: 'a' }],
      patterns: ['method', 'not captured'],
      unless: 'python',
      sample: 'Methods are not captured.',
      refutation: 'TS methods are not captured, Python ones are.',
    },
  ],
}

test('sentences split at line breaks and sentence ends, keeping file:line references whole', () => {
  assert.deepEqual(sentences('It is at store.ts:106. Then crdt-write.ts:79 runs!\n| a | b |\n\nDone?'), [
    'It is at store.ts:106.',
    'Then crdt-write.ts:79 runs!',
    '| a | b |',
    'Done?',
  ])
})

test('a fact is found only when every pattern matches, case-insensitively', () => {
  const g = gradeAnswer(task, 'searchNotes fuses with rrf (k = 60). The definition is in STORE.TS at line 106.')
  assert.deepEqual(
    g.facts.map((f) => [f.id, f.found]),
    [
      ['X.1', true],
      ['X.2', true],
      ['X.3', false],
    ],
  )
  assert.equal(g.found, 2)
  assert.equal(g.total, 3)
  assert.equal(g.recall, 0.6667)
  assert.equal(gradeAnswer(task, 'store.ts only').facts[0]!.found, false)
})

test('an empty answer finds nothing and claims nothing', () => {
  const g = gradeAnswer(task, '')
  assert.equal(g.found, 0)
  assert.equal(g.recall, 0)
  assert.deepEqual(g.falseClaims, [])
})

test('a false claim is flagged per sentence, not when the sentence denies or reports it', () => {
  assert.equal(claimSentence(task.falseClaims[0]!, 'Ranking: it uses BM25 for keywords.'), 'Ranking: it uses BM25 for keywords.')
  for (const denial of ['There is no BM25.', "It doesn't use BM25.", 'The README says BM25.', 'BM25 is wrong here.', 'It ranks with ts_rank instead of BM25.']) {
    assert.equal(claimSentence(task.falseClaims[0]!, denial), null, denial)
  }
  // The patterns must meet in one sentence.
  assert.equal(claimSentence(task.falseClaims[1]!, 'Methods exist. Some are not captured.'), null)
  // A claim worded negatively brings its own `unless`.
  assert.equal(claimSentence(task.falseClaims[1]!, 'Methods are not captured.'), 'Methods are not captured.')
  assert.equal(claimSentence(task.falseClaims[1]!, 'TS methods are not captured, Python ones are.'), null)
})

test('gradeAnswer reports each false claim once with its sentence', () => {
  const g = gradeAnswer(task, 'It uses BM25.\nAgain, it uses BM25.\nMethods are not captured.')
  assert.deepEqual(g.falseClaims, [
    { id: 'X.F1', sentence: 'It uses BM25.' },
    { id: 'X.F2', sentence: 'Methods are not captured.' },
  ])
})

test('every key fact of the task file is found in its own sample phrasing', () => {
  for (const t of file.tasks) {
    for (const f of t.facts) {
      const g = gradeAnswer({ ...t, facts: [f], falseClaims: [] }, f.sample)
      assert.equal(g.found, 1, `${f.id} not found in its sample: ${f.sample}`)
    }
  }
})

test('every false claim of the task file is flagged in its sample and not in its refutation', () => {
  for (const t of file.tasks) {
    for (const c of t.falseClaims) {
      assert.notEqual(claimSentence(c, c.sample), null, `${c.id} not flagged: ${c.sample}`)
      assert.equal(claimSentence(c, c.refutation), null, `${c.id} flagged in its refutation: ${c.refutation}`)
    }
  }
})

test("a task's prompt alone scores no fact (the grade is not handed out by repeating the question)", () => {
  for (const t of file.tasks) {
    const g = gradeAnswer(t, t.prompt)
    assert.deepEqual(
      g.facts.filter((f) => f.found).map((f) => f.id),
      [],
      `${t.id}: the prompt alone finds facts`,
    )
  }
})
