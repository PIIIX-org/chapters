// Unit tests for the pure parts of fails-before.mjs (#575).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  addedExports,
  classifyFile,
  isFixTitle,
  isTestFile,
  isTestSide,
  MISSING_BINDING,
  parseJustification,
  parseNameStatus,
  probeSource,
  relativeImports,
  summaryTable,
  verdict,
} from './fails-before.mjs'

describe('isFixTitle', () => {
  it('accepts conventional fix titles', () => {
    assert.ok(isFixTitle('fix: x'))
    assert.ok(isFixTitle('fix(mcp): scan responses (#577)'))
    assert.ok(isFixTitle('fix!: breaking'))
    assert.ok(isFixTitle('fix(scope)!: breaking'))
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
  it('does not count `because` toward the reason length', () => {
    assert.equal(parseJustification('Fails-before: n/a because ok'), null)
    assert.equal(
      parseJustification('Fails-before: n/a because 123456789'),
      null,
    )
    assert.equal(
      parseJustification('Fails-before: n/a because 1234567890'),
      'Fails-before: n/a because 1234567890',
    )
  })
  it('rejects the placeholder from the failure message', () => {
    assert.equal(
      parseJustification(
        'Fails-before: n/a because <why no test can fail before this fix>',
      ),
      null,
    )
    assert.equal(parseJustification('Fails-before: n/a because <reason>'), null)
    assert.equal(
      parseJustification('Fails-before: n/a because <why> it is docs only'),
      'Fails-before: n/a because <why> it is docs only',
    )
  })
})

describe('test-side paths', () => {
  it('classifies server and client tests and helpers', () => {
    assert.ok(isTestSide('server/test/helpers.ts'))
    assert.ok(isTestSide('server/test/fixtures/a.md'))
    assert.ok(isTestSide('client/src/lib/__snapshots__/a.test.ts.snap'))
    assert.ok(isTestSide('client/src/__snapshots__/b.test.tsx.snap'))
    assert.ok(!isTestFile('client/src/lib/__snapshots__/a.test.ts.snap'))
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
      ignored: [],
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

  const bindingMessages = [
    'TypeError: (0 , __vite_ssr_import_0__.newFn) is not a function',
    'TypeError: (0,__vite_ssr_import_2__.newFn) is not a function\n    at x',
    'TypeError: __vite_ssr_import_1__.Store is not a constructor',
    'TypeError: (0 , __vi_import_0__.newFn) is not a function',
  ]
  it('recognises missing import bindings', () => {
    for (const m of bindingMessages) assert.match(m, MISSING_BINDING)
    assert.doesNotMatch('TypeError: x is not a function', MISSING_BINDING)
    assert.doesNotMatch(
      "TypeError: Cannot read properties of undefined (reading 'a')",
      MISSING_BINDING,
    )
  })
  it('does not count failures on a missing import binding', () => {
    for (const m of bindingMessages) {
      const r = classifyFile({
        status: 'failed',
        message: '',
        assertionResults: [assertion('uses new export', 'failed', m)],
      })
      assert.equal(r.kind, 'missing-export', m)
      assert.deepEqual(r.exports, [])
    }
  })
  it('counts a real failure next to a binding failure, listing the other', () => {
    const r = classifyFile({
      status: 'failed',
      message: '',
      assertionResults: [
        assertion('new', 'failed', bindingMessages[0]),
        assertion('old', 'failed', 'AssertionError: expected 1 to be 2'),
      ],
    })
    assert.equal(r.kind, 'failed')
    assert.deepEqual(
      r.tests.map((t) => t.name),
      ['old'],
    )
    assert.deepEqual(
      r.ignored.map((t) => t.name),
      ['new'],
    )
  })
  it('does not count any failure in a file that imports an added export', () => {
    const exports = [{ spec: '../src/x.js', name: 'LIMIT' }]
    const r = classifyFile(
      {
        status: 'failed',
        message: '',
        assertionResults: [
          assertion(
            'limit',
            'failed',
            "TypeError: Cannot read properties of undefined (reading 'max')",
          ),
        ],
      },
      exports,
    )
    assert.equal(r.kind, 'missing-export')
    assert.deepEqual(r.exports, exports)
  })
})

describe('export probe', () => {
  it('collects named value imports from repo modules', () => {
    const src = [
      "import { describe, it } from 'vitest'",
      "import './setup'",
      "import Def, { a, b as c, type T } from '../src/x.js'",
      'import {',
      '  d,',
      '  default as e,',
      "} from './y'",
      "import type { U } from '../src/types.js'",
      "import * as ns from '../src/z.js'",
      "import { f } from '@/lib/api'",
      "import { g } from 'node:fs'",
    ].join('\n')
    assert.deepEqual(relativeImports(src), [
      { spec: '../src/x.js', names: ['default', 'a', 'b'] },
      { spec: './y', names: ['d', 'default'] },
      { spec: '@/lib/api', names: ['f'] },
    ])
  })
  it('writes a probe that imports each module literally', () => {
    const s = probeSource(
      [{ spec: '../src/x.js', names: ['a'] }],
      '/tmp/out.json',
    )
    assert.match(s, /await import\("\.\.\/src\/x\.js"\)/)
    assert.match(s, /\["a"\]\.filter\(\(n\) => !\(n in m\)\)/)
    assert.match(s, /writeFileSync\("\/tmp\/out\.json"/)
  })
  it('keeps names missing on base and present on head', () => {
    const base = { '../src/x.js': ['newFn', 'SomeType'], './y': 'error: boom' }
    const head = { '../src/x.js': ['SomeType'] }
    assert.deepEqual(addedExports(base, head), [
      { spec: '../src/x.js', name: 'newFn' },
    ])
    assert.deepEqual(addedExports(base, null), [
      { spec: '../src/x.js', name: 'newFn' },
      { spec: '../src/x.js', name: 'SomeType' },
    ])
    assert.deepEqual(addedExports(null, head), [])
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
  it('fails when the only failures are on a missing export', () => {
    const v = verdict({
      a: { kind: 'missing-export', exports: [], tests: [] },
      b: passed,
    })
    assert.equal(v.ok, false)
    assert.match(v.reason, /import an export the PR adds/)
  })
  it('renders a table row per file', () => {
    const t = summaryTable({
      'server/test/a.test.ts': { ...failed, ignored: [] },
      'client/src/b.test.tsx': loadError,
      'server/test/c.test.ts': {
        kind: 'missing-export',
        exports: [{ spec: '../src/x.js', name: 'newFn' }],
        tests: [{ name: 'n', message: 'TypeError: boom' }],
      },
    })
    assert.match(t, /server\/test\/a\.test\.ts` \| ❌ test failed \(1\)/)
    assert.match(
      t,
      /client\/src\/b\.test\.tsx` \| ⚠️ suite failed to load \| SyntaxError/,
    )
    assert.match(
      t,
      /c\.test\.ts` \| ⚠️ failed on a missing export \(not counted\) \| imports exports the base lacks: `newFn` from `\.\.\/src\/x\.js`/,
    )
  })
})
