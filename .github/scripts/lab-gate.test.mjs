// Unit tests for the pure parts of lab-gate.mjs (#576).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { checkKind, entryMatches, evaluate, lintBaseline, render, validateBaseline } from './lab-gate.mjs'

const check = (name, ok) => ({ name, expected: 'e', actual: 'a', ok })
const result = (...checks) => ({ harness: 'ok', checks })
const baseline = (...defects) => ({ defects })
const run = (tier, ...tests) => ({ tier, filters: [], tests })

describe('validateBaseline', () => {
  it('accepts check and anchored match entries, with a state', () => {
    assert.deepEqual(
      validateBaseline(
        baseline(
          { test: 't', check: 'c', issue: 1 },
          { test: 't', check: 'c', issue: 1, state: 'inconclusive' },
          { test: 't', match: '^kill \\S+: x$', issue: 2, intermittent: 'depends on kill timing' },
        ),
      ),
      [],
    )
  })

  it('rejects entries without exactly one of check/match, bad or unanchored regexes, states, issues and reasons', () => {
    const errors = validateBaseline(
      baseline(
        { test: 't', issue: 1 },
        { test: 't', check: 'c', match: '^c$', issue: 1 },
        { test: 't', match: '^($', issue: 1 },
        { test: 't', match: 'S1', issue: 1 },
        { test: 't', match: '^.*', issue: 1 },
        { test: 't', check: 'c', issue: 1, state: 'passed' },
        { test: 't', check: 'c', issue: '1' },
        { test: '', check: 'c', issue: 1 },
        { test: 't', check: 'c', issue: 1, intermittent: 'flaky' },
      ),
    )
    assert.equal(errors.length, 9)
    assert.match(errors[2], /not a valid regex/)
    assert.match(errors[3], /anchored/)
    assert.match(errors[4], /anchored/)
  })

  it('rejects a file without a defects array', () => {
    assert.deepEqual(validateBaseline(null), ['baseline has no "defects" array'])
  })

  it('the committed baseline is valid', () => {
    const committed = JSON.parse(readFileSync(new URL('../../lab/known-defects.json', import.meta.url), 'utf8'))
    assert.deepEqual(validateBaseline(committed), [])
  })
})

describe('entryMatches and checkKind', () => {
  it('matches exact names and regexes, only within the same test', () => {
    assert.ok(entryMatches({ test: 't', check: 'a b' }, 't', 'a b'))
    assert.ok(!entryMatches({ test: 't', check: 'a b' }, 'u', 'a b'))
    assert.ok(entryMatches({ test: 't', match: '^kill \\S+: x$' }, 't', 'kill a4: x'))
    assert.ok(!entryMatches({ test: 't', match: '^kill \\S+: x$' }, 't', 'control: x'))
  })

  it('takes numbers and their glued letter out of a name', () => {
    assert.equal(checkKind('kill t100: x'), checkKind('kill a38: x'))
    assert.equal(checkKind('S17 SIGKILL 2100 ms after ack: @M17d2100@ kept'), '# SIGKILL # ms after ack: @##@ kept')
    assert.notEqual(checkKind('S17 SIGKILL 2100 ms after ack: no duplicated text'), checkKind('S17 SIGKILL 2100 ms after ack: disk = DB'))
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
      r.regressions.map((x) => [x.check, x.state]),
      [['new', 'failed']],
    )
  })

  it('fails on a new inconclusive check, passes a baselined one', () => {
    const args = { run: run('fast', 't'), results: { t: result(check('pinned token works', null)) }, issueStates: open }
    const fresh = evaluate({ ...args, baseline: baseline() })
    assert.equal(fresh.ok, false)
    assert.deepEqual(
      fresh.regressions.map((x) => x.state),
      ['inconclusive'],
    )
    // A "failed" entry does not cover an inconclusive check.
    assert.equal(evaluate({ ...args, baseline: baseline({ test: 't', check: 'pinned token works', issue: 1 }) }).ok, false)
    const known = evaluate({ ...args, baseline: baseline({ test: 't', check: 'pinned token works', issue: 1, state: 'inconclusive' }) })
    assert.equal(known.ok, true)
    assert.match(render(known), /0 failed and 1 inconclusive as known/)
  })

  it('every check inconclusive fails the run', () => {
    const r = evaluate({
      run: run('fast', 't'),
      results: { t: result(check('a', null), check('b', null), check('c', null)) },
      baseline: baseline(),
      issueStates: {},
    })
    assert.equal(r.ok, false)
    assert.equal(r.regressions.length, 3)
  })

  it('fails on a baseline entry whose check now passes (stale)', () => {
    const r = evaluate({
      run: run('fast', 't'),
      results: { t: result(check('bad', true)) },
      baseline: baseline({ test: 't', check: 'bad', issue: 1 }),
      issueStates: open,
    })
    assert.equal(r.ok, false)
    assert.match(r.stale[0].reason, /no longer failed/)
  })

  it('an inconclusive entry whose check now fails is stale and a regression', () => {
    const r = evaluate({
      run: run('fast', 't'),
      results: { t: result(check('x', false)) },
      baseline: baseline({ test: 't', check: 'x', issue: 1, state: 'inconclusive' }),
      issueStates: open,
    })
    assert.equal(r.ok, false)
    assert.equal(r.regressions.length, 1)
    assert.match(r.stale[0].reason, /no longer inconclusive/)
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

  it('fails on a regex entry that covers more than one kind of check', () => {
    const r = evaluate({
      run: run('full', 't'),
      results: {
        t: result(check('S17 SIGKILL 2100 ms after ack: no duplicated text', false), check('S17 SIGKILL 2100 ms after ack: disk = DB', true)),
      },
      baseline: baseline({ test: 't', match: '^S17 SIGKILL \\d+ ms after ack: .*$', issue: 1, intermittent: 'depends on kill timing' }),
      issueStates: open,
    })
    assert.equal(r.ok, false)
    assert.equal(r.families[0].kinds.length, 2)
    assert.match(render(r), /more than one kind of check/)
  })

  it('a missing check or test is stale only in an unfiltered full-tier run', () => {
    const args = {
      results: { t: result(check('other', true)) },
      baseline: baseline({ test: 't', check: 'gone', issue: 1 }, { test: 'removed', check: 'x', issue: 2 }),
      issueStates: open,
    }
    assert.equal(evaluate({ ...args, run: run('fast', 't') }).ok, true)
    assert.equal(evaluate({ ...args, run: { tier: 'full', filters: ['t'], tests: ['t'] } }).ok, true)
    const full = evaluate({ ...args, run: run('full', 't') })
    assert.equal(full.ok, false)
    assert.deepEqual(
      full.stale.map((s) => s.reason),
      ['the test no longer reports this check', 'the test no longer exists'],
    )
  })

  it('fails on a crashed test, a test without a result and a test without checks', () => {
    const r = evaluate({
      run: run('fast', 't', 'u', 'v', 'w'),
      results: { t: { harness: 'crashed', error: 'boom\nstack' }, v: { harness: 'ok', checks: [] }, w: { harness: 'ok' } },
      baseline: baseline(),
      issueStates: {},
    })
    assert.equal(r.ok, false)
    assert.deepEqual(r.crashed, [
      { test: 't', error: 'boom' },
      { test: 'v', error: 'reported no checks' },
      { test: 'w', error: 'reported no checks' },
    ])
    assert.deepEqual(r.missing, ['u'])
  })

  it('fails when the runner never wrote run.json', () => {
    const r = evaluate({ run: null, results: {}, baseline: baseline(), issueStates: {} })
    assert.equal(r.ok, false)
    assert.match(render(r), /run\.json is missing/)
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

describe('lintBaseline', () => {
  const runs = [
    { results: { t: result(check('kill t100: x', false), check('kill a4: x', true), check('S17 2100: dup', true), check('S17 2100: disk', true)) } },
    { results: { t: result(check('kill t100: x', true), check('S17 2050: dup', false), check('S17 2050: disk', true), check('maybe', null)) } },
  ]

  it('accepts entries that were in their state in some run, per kind', () => {
    const b = baseline(
      { test: 't', match: '^kill \\S+: x$', issue: 1, intermittent: 'depends on kill timing' },
      { test: 't', match: '^S17 \\d+: dup$', issue: 1, intermittent: 'depends on kill timing' },
      { test: 't', check: 'maybe', issue: 1, state: 'inconclusive' },
    )
    assert.deepEqual(lintBaseline(b, runs), [])
  })

  it('rejects a family covering a kind that never failed, and entries that match nothing', () => {
    const b = baseline(
      { test: 't', match: '^S17 \\d+: .*$', issue: 1, intermittent: 'depends on kill timing' },
      { test: 't', check: 'nowhere', issue: 1 },
    )
    const problems = lintBaseline(b, runs)
    assert.equal(problems.length, 2)
    assert.match(problems[0], /covers "# #: disk", which was never failed/)
    assert.match(problems[1], /matches no check/)
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
