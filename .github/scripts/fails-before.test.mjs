// Unit tests for the pure parts of fails-before.mjs (#575).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  classifyFile,
  isFixTitle,
  isTestFile,
  isTestSide,
  parseJustification,
  parseNameStatus,
  summaryTable,
  verdict,
} from './fails-before.mjs'

describe('isFixTitle', () => {
  it('accepts conventional fix titles', () => {
    assert.ok(isFixTitle('fix: x'))
    assert.ok(isFixTitle('fix(mcp): scan responses (#577)'))
    assert.ok(isFixTitle('fix!: breaking'))
    assert.ok(isFixTitle('Fix(notes): capitalised'))
  })
  it('rejects other types and lookalikes', () => {
    assert.ok(!isFixTitle('feat(x): y'))
    assert.ok(!isFixTitle('ci: publish after CI'))
    assert.ok(!isFixTitle('fixes the thing'))
    assert.ok(!isFixTitle('fixture: data'))
    assert.ok(!isFixTitle('docs: fix: typo'))
    assert.ok(!isFixTitle(undefined))
  })
})

describe('parseJustification', () => {
  it('finds the line with a reason', () => {
    const body =
      'Problem\n\nFails-before: n/a because the fix is docs only\nmore'
    assert.equal(
      parseJustification(body),
      'Fails-before: n/a because the fix is docs only',
    )
  })
  it('accepts bold, bullets and CRLF', () => {
    assert.equal(
      parseJustification(
        '- **Fails-before:** n/a - CI-only change, no test can run it\r\n',
      ),
      '- **Fails-before:** n/a - CI-only change, no test can run it',
    )
  })
  it('rejects a missing or empty reason', () => {
    assert.equal(parseJustification(null), null)
    assert.equal(parseJustification('nothing here'), null)
    assert.equal(parseJustification('Fails-before: n/a'), null)
    assert.equal(parseJustification('Fails-before: n/a because'), null)
    assert.equal(
      parseJustification('Fails-before: yes, see run 123 and more text'),
      null,
    )
  })
})

describe('test-side paths', () => {
  it('classifies server and client tests and helpers', () => {
    assert.ok(isTestSide('server/test/helpers.ts'))
    assert.ok(isTestSide('server/test/fixtures/a.md'))
    assert.ok(isTestSide('client/src/test/setup.ts'))
    assert.ok(isTestSide('client/src/components/Foo.test.tsx'))
    assert.ok(!isTestSide('server/src/notes/store.ts'))
    assert.ok(!isTestSide('client/src/components/Foo.tsx'))
    assert.ok(!isTestSide('docs/agents/STATE.md'))
    assert.ok(isTestFile('server/test/notes.test.ts'))
    assert.ok(isTestFile('client/src/lib/a.test.ts'))
    assert.ok(!isTestFile('server/test/helpers.ts'))
    assert.ok(!isTestFile('server/src/a.test.ts'))
  })
})

describe('parseNameStatus', () => {
  it('parses -z output', () => {
    const out =
      'M\0server/src/a.ts\0A\0server/test/a.test.ts\0D\0client/src/b.test.tsx\0'
    assert.deepEqual(parseNameStatus(out), [
      { status: 'M', path: 'server/src/a.ts' },
      { status: 'A', path: 'server/test/a.test.ts' },
      { status: 'D', path: 'client/src/b.test.tsx' },
    ])
  })
})

const assertion = (fullName, status, msg) => ({
  fullName,
  title: fullName,
  status,
  failureMessages: msg ? [msg] : [],
})

describe('classifyFile', () => {
  it('reports failing tests', () => {
    const r = classifyFile({
      status: 'failed',
      message: '',
      assertionResults: [
        assertion('a ok', 'passed'),
        assertion(
          'a breaks',
          'failed',
          '\u001b[31mAssertionError: expected 1 to be 2\u001b[39m\n  at x',
        ),
      ],
    })
    assert.deepEqual(r, {
      kind: 'failed',
      tests: [
        { name: 'a breaks', message: 'AssertionError: expected 1 to be 2' },
      ],
    })
  })
  it('reports a suite that failed to load', () => {
    const r = classifyFile({
      status: 'failed',
      message:
        'Failed to load url ../src/new-module.js (resolved id: ../src/new-module.js)',
      assertionResults: [],
    })
    assert.equal(r.kind, 'load-error')
    assert.match(r.message, /Failed to load url/)
  })
  it('reports a passing file', () => {
    const r = classifyFile({
      status: 'passed',
      message: '',
      assertionResults: [assertion('a', 'passed'), assertion('b', 'skipped')],
    })
    assert.deepEqual(r, { kind: 'passed', count: 1 })
  })
})

describe('verdict', () => {
  const failed = { kind: 'failed', tests: [{ name: 't', message: 'm' }] }
  const passed = { kind: 'passed', count: 3 }
  const loadError = { kind: 'load-error', message: 'SyntaxError' }
  it('passes when any test fails on base', () => {
    assert.equal(verdict({ a: failed, b: passed, c: loadError }).ok, true)
  })
  it('fails when everything passes on base', () => {
    const v = verdict({ a: passed })
    assert.equal(v.ok, false)
    assert.match(v.reason, /passes on the base commit/)
  })
  it('fails, naming load errors, when nothing failed on an assertion', () => {
    const v = verdict({ a: passed, b: loadError })
    assert.equal(v.ok, false)
    assert.match(v.reason, /did not load or run/)
  })
  it('renders a table row per file', () => {
    const t = summaryTable({
      'server/test/a.test.ts': failed,
      'client/src/b.test.tsx': loadError,
    })
    assert.match(t, /server\/test\/a\.test\.ts` \| ❌ test failed \(1\)/)
    assert.match(
      t,
      /client\/src\/b\.test\.tsx` \| ⚠️ suite failed to load \| SyntaxError/,
    )
  })
})
