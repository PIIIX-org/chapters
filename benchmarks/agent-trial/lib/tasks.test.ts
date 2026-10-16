import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkEvidence, parseLines, selectTasks, validateTasks, type TaskFile } from './tasks.ts'

const file = JSON.parse(readFileSync(new URL('../tasks.json', import.meta.url), 'utf8')) as TaskFile

test('the task file is valid: the 8 study tasks, pinned to a full commit', () => {
  assert.deepEqual(validateTasks(file), [])
  assert.deepEqual(
    file.tasks.map((t) => t.id),
    ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'],
  )
  assert.match(file.repo.commit, /^[0-9a-f]{40}$/)
  for (const t of file.tasks) assert.ok(t.facts.length >= 7, `${t.id} has only ${t.facts.length} facts`)
})

test('validateTasks reports broken entries', () => {
  const broken: TaskFile = {
    version: 1,
    repo: { url: 'git@github.com:x/y.git', commit: 'abc' },
    source: '',
    tasks: [
      {
        id: 'T1',
        title: 't',
        prompt: ' ',
        facts: [
          { id: 'T1.1', fact: 'f', evidence: [{ path: '../x', lines: '5-2', contains: '' }], patterns: ['(unclosed', 'a*'], sample: '' },
          { id: 'T1.1', fact: 'f', evidence: [], patterns: [], sample: 's' },
        ],
        falseClaims: [{ id: 'T2.F1', claim: 'c', refutedBy: 'r', evidence: [{ path: 'a', lines: '1', contains: 'a' }], patterns: ['x'], unless: '[', sample: 's', refutation: '' }],
      },
    ],
  }
  const errors = validateTasks(broken).join('\n')
  for (const expected of [
    'repo.commit must be a full SHA',
    'repo.url must be https',
    'T1: empty prompt',
    'T1.1: bad line range "5-2"',
    'bad evidence path "../x"',
    'has no anchor',
    'pattern (unclosed',
    'pattern a* matches the empty string',
    'T1.1: no sample',
    'duplicate id T1.1',
    'T1.1: no evidence',
    'T1.1: no patterns',
    'T2.F1: id must start with T1.F',
    'T2.F1: unless [',
    'T2.F1: needs a sample and a refutation',
  ]) {
    assert.ok(errors.includes(expected), `missing "${expected}" in:\n${errors}`)
  }
})

test('parseLines reads N and N-M', () => {
  assert.deepEqual(parseLines('7'), { start: 7, end: 7 })
  assert.deepEqual(parseLines('15-44'), { start: 15, end: 44 })
  for (const bad of ['0', '4-3', 'a', '1-', '']) assert.throws(() => parseLines(bad), /bad line range/, bad)
})

test('checkEvidence needs the file, the range and the anchor in that range', () => {
  const small: TaskFile = {
    ...file,
    tasks: [
      {
        id: 'T1',
        title: 't',
        prompt: 'p',
        facts: [
          {
            id: 'T1.1',
            fact: 'f',
            evidence: [
              { path: 'a.ts', lines: '2-3', contains: 'needle' },
              { path: 'a.ts', lines: '1', contains: 'needle' },
              { path: 'a.ts', lines: '3-9', contains: 'needle' },
              { path: 'gone.ts', lines: '1', contains: 'x' },
            ],
            patterns: ['f'],
            sample: 'f',
          },
        ],
        falseClaims: [],
      },
    ],
  }
  const lines = (p: string) => (p === 'a.ts' ? ['one', 'two', 'the needle', 'four'] : null)
  assert.deepEqual(checkEvidence(small, lines), [
    'T1.1: a.ts:1 does not contain "needle"',
    'T1.1: a.ts:3-9 is past the end of the file (4 lines)',
    'T1.1: gone.ts does not exist',
  ])
})

test('selectTasks keeps file order, and refuses unknown ids', () => {
  assert.equal(selectTasks(file, '').length, 8)
  assert.deepEqual(
    selectTasks(file, ' T3 ,T1').map((t) => t.id),
    ['T1', 'T3'],
  )
  assert.throws(() => selectTasks(file, 'T1,T9'), /unknown tasks T9/)
})
