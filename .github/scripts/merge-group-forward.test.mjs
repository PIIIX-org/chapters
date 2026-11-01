// Unit tests for the pure parts of merge-group-forward.mjs.
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  awaitRun,
  forward,
  headMismatch,
  PASSING,
  pickCheckRun,
  prNumberFromHeadRef,
  WAIT_MS,
} from './merge-group-forward.mjs'

describe('prNumberFromHeadRef', () => {
  it('reads the PR number from a queue branch', () => {
    assert.equal(
      prNumberFromHeadRef('gh-readonly-queue/dev/pr-1052-36b98a76098e'),
      1052,
    )
    assert.equal(
      prNumberFromHeadRef(
        'refs/heads/gh-readonly-queue/dev/pr-7-36b98a76098e0f1a2b3c4d5e6f708192a3b4c5d6',
      ),
      7,
    )
    assert.equal(
      prNumberFromHeadRef('gh-readonly-queue/release/v1/pr-12-abcdef1'),
      12,
    )
  })
  it('rejects other refs', () => {
    assert.equal(prNumberFromHeadRef('fix/123-thing'), null)
    assert.equal(prNumberFromHeadRef('gh-readonly-queue/dev/pr-x-abc'), null)
    assert.equal(prNumberFromHeadRef(''), null)
    assert.equal(prNumberFromHeadRef(undefined), null)
  })
})

const run = (over) => ({
  id: 1,
  name: 'fails-before',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/PIIIX-org/chapters/runs/1',
  app: { slug: 'github-actions' },
  ...over,
})

describe('pickCheckRun', () => {
  it('takes the newest GitHub Actions run with that name', () => {
    const runs = [
      run({ id: 3, conclusion: 'failure' }),
      run({ id: 9, conclusion: 'success' }),
      run({ id: 11, name: 'attribution' }),
      run({ id: 20, app: { slug: 'other-app' } }),
    ]
    assert.equal(pickCheckRun(runs, 'fails-before').id, 9)
    assert.equal(pickCheckRun(runs, 'attribution').id, 11)
  })
  it('returns null without a match', () => {
    assert.equal(pickCheckRun([], 'fails-before'), null)
    assert.equal(pickCheckRun(undefined, 'fails-before'), null)
    assert.equal(pickCheckRun([run({ name: 'checks' })], 'fails-before'), null)
  })
})

describe('forward', () => {
  const ctx = { check: 'fails-before', pr: 42, headSha: 'abcdef0123456789' }
  it('passes on success, skipped and neutral', () => {
    for (const conclusion of PASSING) {
      const v = forward(run({ conclusion }), ctx)
      assert.equal(v.ok, true, conclusion)
      assert.match(
        v.title,
        new RegExp(
          `\`fails-before\` on PR #42 head \`abcdef012345\` concluded \`${conclusion}\``,
        ),
      )
      assert.match(
        v.title,
        /\(\[run\]\(https:\/\/github\.com\/PIIIX-org\/chapters\/runs\/1\)\)/,
      )
    }
  })
  it('fails on failure, cancelled and timed_out with the run link', () => {
    for (const conclusion of [
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
    ]) {
      const v = forward(run({ conclusion }), ctx)
      assert.equal(v.ok, false, conclusion)
      assert.match(v.title, new RegExp(`concluded \`${conclusion}\``))
      assert.match(v.title, /runs\/1/)
      assert.match(v.body, /re-queue/)
    }
  })
  it('fails while the PR-level run is not finished, naming the wait', () => {
    const v = forward(run({ status: 'in_progress', conclusion: null }), ctx)
    assert.equal(v.ok, false)
    assert.match(
      v.title,
      new RegExp(`still in_progress after ${WAIT_MS / 1000}s`),
    )
  })
  it('fails when the PR head has no such run', () => {
    const v = forward(null, ctx)
    assert.equal(v.ok, false)
    assert.match(v.title, /No `fails-before` run on PR #42/)
    assert.match(v.body, /re-queue/)
  })
})

describe('headMismatch', () => {
  const ctx = { pr: 42 }
  it('passes when the queue merged the live PR head', () => {
    assert.equal(
      headMismatch('abcDEF0123456789', 'ABCdef0123456789', ctx),
      null,
    )
  })
  it('refuses when the PR moved after it was queued', () => {
    const v = headMismatch('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', ctx)
    assert.equal(v.ok, false)
    assert.match(
      v.title,
      /PR #42 head is `bbbbbbbbbbbb` but the queue merged `aaaaaaaaaaaa`/,
    )
    assert.match(v.body, /re-queue/)
  })
  it('refuses when the queued head is unknown', () => {
    const v = headMismatch('', 'bbbbbbbbbbbbbbbb', ctx)
    assert.equal(v.ok, false)
    assert.match(v.title, /Cannot identify the PR head inside the queue commit/)
    assert.equal(headMismatch(undefined, 'b', ctx).ok, false)
  })
})

describe('awaitRun', () => {
  const clock = () => {
    let t = 0
    return { now: () => t, sleep: async (ms) => void (t += ms) }
  }
  it('returns a completed run at once', async () => {
    const { now, sleep } = clock()
    let calls = 0
    const r = await awaitRun(async () => (calls++, run()), { now, sleep })
    assert.equal(r.conclusion, 'success')
    assert.equal(calls, 1)
  })
  it('polls while the run is missing, queued or running, then returns it', async () => {
    const { now, sleep } = clock()
    const states = [
      null,
      run({ status: 'queued', conclusion: null }),
      run({ status: 'in_progress', conclusion: null }),
      run(),
    ]
    const logs = []
    const r = await awaitRun(async () => states.shift(), {
      now,
      sleep,
      pollMs: 10,
      waitMs: 1000,
      log: (m) => logs.push(m),
    })
    assert.equal(r.status, 'completed')
    assert.equal(now(), 30)
    assert.deepEqual(logs, [
      'PR-level run not found yet; waiting 0.01s',
      'PR-level run queued; waiting 0.01s',
      'PR-level run in_progress; waiting 0.01s',
    ])
  })
  it('gives up at the deadline and returns the last state', async () => {
    const { now, sleep } = clock()
    let calls = 0
    const r = await awaitRun(
      async () => (calls++, run({ status: 'in_progress', conclusion: null })),
      { now, sleep, pollMs: 50, waitMs: 180 },
    )
    assert.equal(r.status, 'in_progress')
    assert.equal(calls, 5) // t = 0, 50, 100, 150, 200
    assert.equal(
      forward(r, { check: 'fails-before', pr: 1, headSha: 'x' }).ok,
      false,
    )
  })
})
