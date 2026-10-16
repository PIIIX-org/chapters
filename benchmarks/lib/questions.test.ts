import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fingerprint, parseGold, validateSuite, type Suite } from './questions.ts'

const DIR = join(import.meta.dirname, '..', 'questions')
const suites = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, suite: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Suite }))

test('every committed suite is valid and named after its file', () => {
  assert.deepEqual(suites.map((s) => s.file).sort(), ['chapters.json', 'context-mode.json', 'diagram-design.json', 'rea.json', 'vectorcraft.json'])
  for (const { file, suite } of suites) {
    assert.equal(`${suite.suite}.json`, file)
    assert.deepEqual(validateSuite(suite), [], file)
  }
})

test('suite sizes: 29 chapters questions, 20 per mapped repository', () => {
  const sizes = Object.fromEntries(suites.map(({ suite }) => [suite.suite, suite.questions.length]))
  assert.deepEqual(sizes, { chapters: 29, 'context-mode': 20, 'diagram-design': 20, rea: 20, vectorcraft: 20 })
})

test('parseGold reads path:line and path:start-end', () => {
  assert.deepEqual(parseGold('a/b.ts:7'), { path: 'a/b.ts', start: 7, end: 7 })
  assert.deepEqual(parseGold('a/b.ts:7-41'), { path: 'a/b.ts', start: 7, end: 41 })
  assert.deepEqual(parseGold('C:odd/name.ts:3'), { path: 'C:odd/name.ts', start: 3, end: 3 })
  assert.throws(() => parseGold('a/b.ts'), /not path:line/)
  assert.throws(() => parseGold('a/b.ts:9-3'), /empty range/)
  assert.throws(() => parseGold('a/b.ts:0'), /empty range/)
})

test('validateSuite reports structural problems', () => {
  const bad: Suite = {
    suite: 'Bad Name',
    description: '',
    repo: { url: 'git@github.com:x/y.git', commit: 'abc' },
    source: '',
    questions: [
      { id: 'Q1', category: 'where', question: 'q', keywords: ['('], relevant: ['a.ts'], gold: ['b.ts:1'] },
      { id: 'Q1', category: 'where', question: ' ', keywords: [], relevant: [], gold: [] },
    ],
  }
  const errors = validateSuite(bad).join('\n')
  for (const expected of ['suite name', 'public https GitHub URL', '40-hex', 'duplicate id', 'empty question', 'no grep keywords', 'not a valid regex', 'no relevant file', 'no gold evidence', 'missing from relevant']) {
    assert.ok(errors.includes(expected), `missing "${expected}" in:\n${errors}`)
  }
})

test('the fingerprint changes with the questions and with the policy config', () => {
  const s = suites[0]!.suite
  const base = fingerprint(s, { v: 1 })
  assert.equal(fingerprint(s, { v: 1 }), base)
  assert.notEqual(fingerprint(s, { v: 2 }), base)
  const edited: Suite = { ...s, questions: [{ ...s.questions[0]!, keywords: ['other'] }, ...s.questions.slice(1)] }
  assert.notEqual(fingerprint(edited, { v: 1 }), base)
})
