// Unit tests for lab-nightly-alert.mjs (#706), against an in-memory stub of
// the GitHub issues API.
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ISSUE_LABEL,
  ISSUE_TITLE,
  MAX_BODY,
  alert,
  decide,
  gateSummary,
  mode,
  runVerdict,
} from './lab-nightly-alert.mjs'

const REPO = 'PIIIX-org/chapters'
const run = (id) => `https://github.com/${REPO}/actions/runs/${id}`

const RED_NEEDS = {
  plan: { result: 'success', outputs: { tier: 'full' } },
  lab: { result: 'failure', outputs: {} },
  bench: { result: 'success', outputs: {} },
  'bench-gate': { result: 'success', outputs: {} },
}
const GREEN_NEEDS = {
  plan: { result: 'success', outputs: { tier: 'full' } },
  lab: { result: 'success', outputs: {} },
  bench: { result: 'success', outputs: {} },
  'bench-gate': { result: 'success', outputs: {} },
}

const LAB_GATE = `# Lab gate: FAIL

Tier **full**, 21 tests. 900 checks passed, 3 failed and 0 inconclusive as known (3 baseline entries), 1 regressions, 1 stale entries, 0 over-broad families, 1 harness failures.

## Harness failures

A test threw, timed out, wrote no result or reported no checks: fix the test or the instance before reading its checks.

- \`big-notes\`: timed out after 90 min

## Regressions (failed or inconclusive, not in the baseline)

| test | check | state | severity | expected | actual |
|---|---|---|---|---|---|
| crash-write | C3 note survives SIGKILL | failed | data-loss | on disk | missing |

## Stale baseline entries

| test | check | issue | why |
|---|---|---|---|
| smoke | S1 | [#123](https://github.com/PIIIX-org/chapters/issues/123) | no longer failed (passed) |

## Known defects (as expected)

| test | check | state | issue | count |
|---|---|---|---|---|
| concurrency | K9 | failed | [#456](https://github.com/PIIIX-org/chapters/issues/456) | 1/1 |
`

/**
 * The slice of the GitHub REST API the script uses: list issues by label
 * (paginated), create, read, comment, patch. Records every write.
 */
function stubGitHub({ pageSize = 100 } = {}) {
  const issues = []
  const writes = []
  let nextNumber = 900
  const api = async (path, { method = 'GET', body } = {}) => {
    const url = new URL(path, 'https://api.github.com')
    const p = url.pathname
    if (method !== 'GET') writes.push({ method, path: p, body })
    let m
    if (method === 'GET' && p === `/repos/${REPO}/issues`) {
      const labels = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean)
      const state = url.searchParams.get('state') ?? 'open'
      const page = Number(url.searchParams.get('page') ?? 1)
      const all = issues.filter(
        (i) => (state === 'all' || i.state === state) && labels.every((l) => i.labels.some((x) => x.name === l)),
      )
      const data = all.slice((page - 1) * pageSize, page * pageSize)
      const more = all.length > page * pageSize
      url.searchParams.set('page', String(page + 1))
      return { data, next: more ? url.href : undefined }
    }
    if (method === 'POST' && p === `/repos/${REPO}/issues`) {
      const issue = {
        number: nextNumber++,
        title: body.title,
        body: body.body,
        state: 'open',
        labels: (body.labels ?? []).map((name) => ({ name })),
        comments: [],
        html_url: `https://github.com/${REPO}/issues/${nextNumber - 1}`,
      }
      issues.push(issue)
      return { data: issue }
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(p)) && method === 'POST') {
      const issue = issues.find((i) => i.number === Number(m[1]))
      issue.comments.push(body.body)
      return { data: { id: issue.comments.length } }
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(p))) {
      const issue = issues.find((i) => i.number === Number(m[1]))
      if (method === 'PATCH') Object.assign(issue, body)
      return { data: issue }
    }
    throw new Error(`stub: unexpected ${method} ${path}`)
  }
  return { api, issues, writes }
}

const nightly = (gh, needs, id, extra = {}) =>
  alert({
    api: gh.api,
    repo: REPO,
    mode: 'live',
    verdict: runVerdict(needs),
    runUrl: run(id),
    labGate: needs === RED_NEEDS ? LAB_GATE : null,
    benchGate: null,
    ...extra,
  })

describe('mode', () => {
  it('is live only for a scheduled run on dev in the main repository', () => {
    assert.equal(mode({ event: 'schedule', ref: 'refs/heads/dev', repo: REPO, dryRun: false }), 'live')
  })
  it('never posts for pull requests, dispatches, other branches or forks', () => {
    for (const ctx of [
      { event: 'pull_request', ref: 'refs/pull/1/merge', repo: REPO },
      { event: 'workflow_dispatch', ref: 'refs/heads/dev', repo: REPO },
      { event: 'push', ref: 'refs/heads/lab/x', repo: REPO },
      { event: 'schedule', ref: 'refs/heads/prod', repo: REPO },
      { event: 'schedule', ref: 'refs/heads/dev', repo: 'someone/chapters' },
    ]) {
      assert.equal(mode({ ...ctx, dryRun: false }), 'skip', JSON.stringify(ctx))
      assert.equal(mode({ ...ctx, dryRun: true }), 'dry-run', JSON.stringify(ctx))
    }
  })
  it('a dry run of the nightly itself posts nothing either', () => {
    assert.equal(mode({ event: 'schedule', ref: 'refs/heads/dev', repo: REPO, dryRun: true }), 'dry-run')
  })
})

describe('runVerdict', () => {
  it('green when every job succeeded or was skipped (bench off)', () => {
    assert.deepEqual(runVerdict(GREEN_NEEDS), { failed: false, jobs: [] })
    assert.equal(runVerdict({ ...GREEN_NEEDS, bench: { result: 'skipped' }, 'bench-gate': { result: 'skipped' } }).failed, false)
  })
  it('red on a failed or cancelled job, listing it', () => {
    assert.deepEqual(runVerdict(RED_NEEDS), { failed: true, jobs: [{ job: 'lab', result: 'failure' }] })
    assert.deepEqual(runVerdict({ ...GREEN_NEEDS, 'bench-gate': { result: 'cancelled' } }).jobs, [
      { job: 'bench-gate', result: 'cancelled' },
    ])
  })
  it('red when the lab job did not run at all (plan failed, so lab was skipped)', () => {
    const v = runVerdict({ ...GREEN_NEEDS, plan: { result: 'failure' }, lab: { result: 'skipped' } })
    assert.equal(v.failed, true)
    assert.deepEqual(v.jobs, [
      { job: 'plan', result: 'failure' },
      { job: 'lab', result: 'skipped' },
    ])
  })
})

describe('gateSummary', () => {
  it('keeps the counts, harness failures, regressions and stale entries; drops the known-defect table', () => {
    const s = gateSummary(LAB_GATE)
    assert.match(s, /1 regressions, 1 stale entries/)
    assert.match(s, /#### Harness failures/)
    assert.match(s, /big-notes/)
    assert.match(s, /C3 note survives SIGKILL/)
    assert.match(s, /#### Stale baseline entries/)
    assert.doesNotMatch(s, /Known defects/)
    assert.doesNotMatch(s, /K9/)
    assert.match(s, /^### Lab gate: FAIL/)
  })
  it('null or empty -> null', () => {
    assert.equal(gateSummary(null), null)
    assert.equal(gateSummary('  \n'), null)
  })
})

describe('decide', () => {
  const open = [{ number: 5 }]
  it('red + none open -> open; red + open -> update; green + open -> close; green + none -> nothing', () => {
    assert.deepEqual(decide({ failed: true, open: [] }), { action: 'open', issues: [] })
    assert.deepEqual(decide({ failed: true, open }), { action: 'update', issues: open })
    assert.deepEqual(decide({ failed: false, open }), { action: 'close', issues: open })
    assert.deepEqual(decide({ failed: false, open: [] }), { action: 'none', issues: [] })
  })
  it('two open issues (one opened by hand): a red run updates the oldest, a green run closes both', () => {
    const two = [{ number: 9 }, { number: 4 }]
    assert.deepEqual(decide({ failed: true, open: two }).issues, [{ number: 4 }])
    assert.deepEqual(decide({ failed: false, open: two }).issues.map((i) => i.number), [4, 9])
  })
})

describe('alert against a stubbed GitHub API', () => {
  it('a failing nightly opens one lab-nightly issue with the gate summary and the run link', async () => {
    const gh = stubGitHub()
    const r = await nightly(gh, RED_NEEDS, 101)
    assert.equal(r.action, 'open')
    assert.equal(gh.issues.length, 1)
    const [issue] = gh.issues
    assert.equal(issue.title, ISSUE_TITLE)
    assert.deepEqual(issue.labels, [{ name: ISSUE_LABEL }])
    assert.equal(issue.state, 'open')
    assert.ok(issue.body.includes(run(101)), 'run link in the body')
    assert.match(issue.body, /`lab`: failure/)
    assert.match(issue.body, /C3 note survives SIGKILL/)
    assert.match(issue.body, /big-notes/)
    assert.match(issue.body, /Stale baseline entries/)
    assert.equal(r.issue, issue.html_url)
  })

  it('a second failing nightly comments on the same issue instead of opening another', async () => {
    const gh = stubGitHub()
    await nightly(gh, RED_NEEDS, 101)
    const r = await nightly(gh, RED_NEEDS, 102)
    assert.equal(r.action, 'update')
    assert.equal(gh.issues.length, 1)
    assert.equal(gh.issues[0].comments.length, 1)
    assert.ok(gh.issues[0].comments[0].includes(run(102)))
    assert.match(gh.issues[0].comments[0], /C3 note survives SIGKILL/)
  })

  it('the next green nightly comments with its run link and closes the issue', async () => {
    const gh = stubGitHub()
    await nightly(gh, RED_NEEDS, 101)
    const r = await nightly(gh, GREEN_NEEDS, 103)
    assert.equal(r.action, 'close')
    const [issue] = gh.issues
    assert.equal(issue.state, 'closed')
    assert.equal(issue.state_reason, 'completed')
    assert.equal(issue.comments.length, 1)
    assert.ok(issue.comments[0].includes(run(103)))
    // Comment first, then close: the comment notifies the issue's subscribers.
    const last = gh.writes.slice(-2).map((w) => w.method)
    assert.deepEqual(last, ['POST', 'PATCH'])
  })

  it('green with nothing open writes nothing; a later failure opens a fresh issue', async () => {
    const gh = stubGitHub()
    await nightly(gh, RED_NEEDS, 101)
    await nightly(gh, GREEN_NEEDS, 102)
    const writes = gh.writes.length
    assert.equal((await nightly(gh, GREEN_NEEDS, 103)).action, 'none')
    assert.equal(gh.writes.length, writes)
    assert.equal((await nightly(gh, RED_NEEDS, 104)).action, 'open')
    assert.equal(gh.issues.length, 2)
    assert.deepEqual(gh.issues.map((i) => i.state), ['closed', 'open'])
  })

  it('finds the open issue on a later page of lab-nightly issues', async () => {
    const gh = stubGitHub({ pageSize: 1 })
    gh.issues.push(
      { number: 1, title: 'something else', state: 'open', labels: [{ name: ISSUE_LABEL }], comments: [] },
      { number: 2, title: 'a PR', state: 'open', labels: [{ name: ISSUE_LABEL }], comments: [], pull_request: {} },
    )
    await nightly(gh, RED_NEEDS, 101)
    assert.equal(gh.issues.length, 3)
    assert.equal((await nightly(gh, RED_NEEDS, 102)).action, 'update')
    assert.equal(gh.issues.length, 3)
    assert.equal(gh.issues[2].comments.length, 1)
  })

  it('a dry run reads the issue and returns the text it would post, writing nothing', async () => {
    const gh = stubGitHub()
    const r = await nightly(gh, RED_NEEDS, 101, { mode: 'dry-run' })
    assert.equal(r.action, 'open')
    assert.equal(r.dryRun, true)
    assert.match(r.body, /C3 note survives SIGKILL/)
    assert.equal(gh.writes.length, 0)
    await nightly(gh, RED_NEEDS, 102)
    const g = await nightly(gh, GREEN_NEEDS, 103, { mode: 'dry-run' })
    assert.equal(g.action, 'close')
    assert.equal(gh.writes.length, 1)
    assert.equal(gh.issues[0].state, 'open')
  })

  it('skip mode makes no API call at all', async () => {
    const r = await alert({
      api: async () => assert.fail('no API call when skipped'),
      repo: REPO,
      mode: 'skip',
      verdict: runVerdict(RED_NEEDS),
      runUrl: run(1),
      labGate: LAB_GATE,
      benchGate: null,
    })
    assert.equal(r.action, 'skip')
  })

  it('a run with no gate summary (the job was cancelled before the gate) still alerts, saying so', async () => {
    const gh = stubGitHub()
    await alert({
      api: gh.api,
      repo: REPO,
      mode: 'live',
      verdict: runVerdict({ ...GREEN_NEEDS, lab: { result: 'cancelled' } }),
      runUrl: run(7),
      labGate: null,
      benchGate: null,
    })
    assert.match(gh.issues[0].body, /`lab`: cancelled/)
    assert.match(gh.issues[0].body, /no lab gate summary/i)
  })

  it('includes the bench gate summary when the benchmark failed', async () => {
    const gh = stubGitHub()
    await alert({
      api: gh.api,
      repo: REPO,
      mode: 'live',
      verdict: runVerdict({ ...GREEN_NEEDS, 'bench-gate': { result: 'failure' } }),
      runUrl: run(8),
      labGate: '# Lab gate: PASS\n\nTier **full**.',
      benchGate: '# Bench gate: FAIL\n\n| suite | metric |\n|---|---|\n| chapters | tokens regression |',
    })
    assert.match(gh.issues[0].body, /### Bench gate: FAIL/)
    assert.match(gh.issues[0].body, /tokens regression/)
  })

  it('a huge gate summary is cut to fit a GitHub issue body', async () => {
    const gh = stubGitHub()
    const big = `# Lab gate: FAIL\n\n## Regressions\n\n${'| t | c | failed |\n'.repeat(20000)}`
    await nightly(gh, RED_NEEDS, 9, { labGate: big })
    assert.ok(gh.issues[0].body.length <= MAX_BODY)
    assert.ok(gh.issues[0].body.includes(run(9)), 'the run link survives the cut')
    assert.match(gh.issues[0].body, /cut/)
  })
})
