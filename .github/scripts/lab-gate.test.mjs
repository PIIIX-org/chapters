// Unit tests for the pure parts of lab-gate.mjs (#576).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { entryMatches, evaluate, render, validateBaseline } from './lab-gate.mjs'

const check = (name, ok) => ({ name, expected: 'e', actual: 'a', ok })
const result = (...checks) => ({ harness: 'ok', checks })
const baseline = (...defects) => ({ defects })
const run = (tier, ...tests) => ({ tier, tests })

describe('validateBaseline', () => {
  it('accepts check and match entries', () => {
    assert.deepEqual(
      validateBaseline(
        baseline(
          { test: 't', check: 'c', issue: 1 },
          { test: 't', match: '^kill \\S+: x$', issue: 2, intermittent: 'depends on kill timing' },
        ),
      ),
      [],
    )
  })

  it('rejects entries without exactly one of check/match, bad regexes, issues and reasons', () => {
    const errors = validateBaseline(
      baseline(
        { test: 't', issue: 1 },
        { test: 't', check: 'c', match: 'c', issue: 1 },
        { test: 't', match: '(', issue: 1 },
        { test: 't', check: 'c', issue: '1' },
        { test: '', check: 'c', issue: 1 },
        { test: 't', check: 'c', issue: 1, intermittent: 'flaky' },
      ),
    )
    assert.equal(errors.length, 6)
    assert.match(errors[2], /not a valid regex/)
  })

  it('rejects a file without a defects array', () => {
    assert.deepEqual(validateBaseline(null), ['baseline has no "defects" array'])
  })

  it('the committed baseline is valid', () => {
    const committed = JSON.parse(readFileSync(new URL('../../lab/known-defects.json', import.meta.url), 'utf8'))
    assert.deepEqual(validateBaseline(committed), [])
  })
})

describe('entryMatches', () => {
  it('matches exact names and regexes, only within the same test', () => {
    assert.ok(entryMatches({ test: 't', check: 'a b' }, 't', 'a b'))
    assert.ok(!entryMatches({ test: 't', check: 'a b' }, 'u', 'a b'))
    assert.ok(entryMatches({ test: 't', match: '^kill \\S+: x$' }, 't', 'kill a4: x'))
    assert.ok(!entryMatches({ test: 't', match: '^kill \\S+: x$' }, 't', 'control: x'))
  })
})

describe('evaluate', () => {
  const open = { 1: 'open', 2: 'open' }

  it('passes when every failure is a known defect', () => {
    const r = evaluate({
      run: run('fast', 't'),
      results: { t: result(check('good', true), check('bad', false)) },
      baseline: baseline({ test: 't', check: 'bad', issue: 1 }),
      issueStates: open,
    })
    assert.equal(r.ok, true)
    assert.equal(r.known.length, 1)
    assert.equal(r.passedChecks, 1)
  })

  it('fails on a failed check outside the baseline (regression)', () => {
    const r = evaluate({
      run: run('fast', 't'),
      results: { t: result(check('new', false)) },
      baseline: baseline(),
      issueStates: {},
    })
    assert.equal(r.ok, false)
    assert.deepEqual(
      r.regressions.map((x) => x.check),
      ['new'],
    )
  })

  it('fails on a baseline entry whose check now passes (stale)', () => {
    const r = evaluate({
      run: run('fast', 't'),
      results: { t: result(check('bad', true)) },
      baseline: baseline({ test: 't', check: 'bad', issue: 1 }),
      issueStates: open,
    })
    assert.equal(r.ok, false)
    assert.match(r.stale[0].reason, /passed/)
  })

  it('lets an intermittent entry pass without failing', () => {
    const r = evaluate({
      run: run('full', 't'),
      results: { t: result(check('kill a1: x', true), check('kill a4: x', true)) },
      baseline: baseline({ test: 't', match: '^kill \\S+: x$', issue: 1, intermittent: 'depends on kill timing' }),
      issueStates: open,
    })
    assert.equal(r.ok, true)
    assert.equal(r.intermittentPassed.length, 1)
  })

  it('a missing check is stale in the full tier only', () => {
    const args = {
      results: { t: result(check('other', true)) },
      baseline: baseline({ test: 't', check: 'gone', issue: 1 }),
      issueStates: open,
    }
    assert.equal(evaluate({ ...args, run: run('fast', 't') }).ok, true)
    const full = evaluate({ ...args, run: run('full', 't') })
    assert.equal(full.ok, false)
    assert.match(full.stale[0].reason, /no longer reports/)
  })

  it('ignores entries of tests that did not run', () => {
    const r = evaluate({
      run: run('fast', 't'),
      results: { t: result(check('good', true)) },
      baseline: baseline({ test: 'u', check: 'bad', issue: 1 }),
      issueStates: open,
    })
    assert.equal(r.ok, true)
  })

  it('fails on a crashed test and on a test without a result', () => {
    const r = evaluate({
      run: run('fast', 't', 'u'),
      results: { t: { harness: 'crashed', error: 'boom\nstack' } },
      baseline: baseline(),
      issueStates: {},
    })
    assert.equal(r.ok, false)
    assert.deepEqual(r.crashed, [{ test: 't', error: 'boom' }])
    assert.deepEqual(r.missing, ['u'])
  })

  it('fails when the runner never wrote run.json', () => {
    const r = evaluate({ run: null, results: {}, baseline: baseline(), issueStates: {} })
    assert.equal(r.ok, false)
    assert.match(render(r), /run\.json is missing/)
  })

  it('does not judge inconclusive checks', () => {
    const r = evaluate({
      run: run('fast', 't'),
      results: { t: result(check('maybe', null)) },
      baseline: baseline(),
      issueStates: {},
    })
    assert.equal(r.ok, true)
    assert.equal(r.inconclusive.length, 1)
  })

  it('fails when an entry points at a closed issue or a PR', () => {
    const r = evaluate({
      run: run('fast', 't'),
      results: { t: result(check('bad', false), check('worse', false)) },
      baseline: baseline({ test: 't', check: 'bad', issue: 1 }, { test: 't', check: 'worse', issue: 2 }),
      issueStates: { 1: 'closed', 2: 'pr' },
    })
    assert.equal(r.ok, false)
    assert.deepEqual(r.issueProblems, [
      { issue: 1, state: 'closed' },
      { issue: 2, state: 'pr' },
    ])
  })

  it('skips the issue rule when states are unknown, and says so', () => {
    const r = evaluate({
      run: run('fast', 't'),
      results: { t: result(check('bad', false)) },
      baseline: baseline({ test: 't', check: 'bad', issue: 1 }),
      issueStates: null,
    })
    assert.equal(r.ok, true)
    assert.match(render(r), /Issue states were not checked/)
  })

  it('fails on an invalid baseline', () => {
    const r = evaluate({
      run: run('fast', 't'),
      results: { t: result(check('good', true)) },
      baseline: baseline({ test: 't', issue: 1 }),
      issueStates: null,
    })
    assert.equal(r.ok, false)
    assert.match(render(r), /Baseline file is invalid/)
  })
})

describe('render', () => {
  it('lists regressions and stale entries with issue links', () => {
    const r = evaluate({
      run: run('full', 't'),
      results: { t: result(check('new | piped', false), check('fixed', true)) },
      baseline: baseline({ test: 't', check: 'fixed', issue: 408 }),
      issueStates: { 408: 'open' },
    })
    const md = render(r, 'o/r')
    assert.match(md, /^# Lab gate: FAIL/)
    assert.match(md, /new \\\| piped/)
    assert.match(md, /\[#408\]\(https:\/\/github\.com\/o\/r\/issues\/408\)/)
  })
})
