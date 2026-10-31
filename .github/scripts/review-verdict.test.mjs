// Unit tests for the pure parts of review-verdict.mjs (#574).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  contextFor,
  evaluate,
  gateFor,
  headReviewed,
  headSince,
  mergeGroupPr,
  queueContains,
  reviewLinks,
  verdictOf,
} from './review-verdict.mjs'

const HEAD = 'a1b2c3d'.padEnd(40, 'e')
const OLD = 'b'.repeat(40)
const PR_URL = 'https://github.com/PIIIX-org/chapters/pull/700'
const RECORD = 'https://github.com/PIIIX-org/chapters/issues/574#issuecomment-1'
const pr = { user: { login: 'Taha-Mahmoodi' }, head: { sha: HEAD }, base: { ref: 'prod' }, html_url: PR_URL }
const since = headSince({ commitDate: '2026-10-16T10:00:00Z' })
const writers = new Set(['Taha-Mahmoodi', 'reviewer'])

let id = 0
const comment = (body, created_at, over = {}) => ({
  body,
  created_at,
  user: { login: 'Taha-Mahmoodi', type: 'User' },
  html_url: `${PR_URL}#issuecomment-${++id}`,
  ...over,
})
const review = (state, commit_id, submitted_at, login = 'reviewer', type = 'User') => ({
  state,
  commit_id,
  submitted_at,
  user: { login, type },
})
const merge = `VERDICT: MERGE\n\nReview: ${RECORD}\nHead reviewed: ${HEAD.slice(0, 12)}`
const run = (over) => evaluate({ pr, since, writers, ...over })

describe('verdictOf', () => {
  it('reads an exact first line', () => {
    assert.equal(verdictOf('VERDICT: MERGE'), 'MERGE')
    assert.equal(verdictOf('VERDICT: CHANGES\n1. broken'), 'CHANGES')
    assert.equal(verdictOf('\r\n  VERDICT: MERGE  \r\nReview: x'), 'MERGE')
  })
  it('ignores a verdict that is not the first line or not exact', () => {
    assert.equal(verdictOf('Looks fine.\nVERDICT: MERGE'), null)
    assert.equal(verdictOf('verdict: merge'), null)
    assert.equal(verdictOf('VERDICT: MERGE, mostly'), null)
    assert.equal(verdictOf('**VERDICT: MERGE**'), null)
    assert.equal(verdictOf('> VERDICT: MERGE'), null)
    assert.equal(verdictOf(''), null)
    assert.equal(verdictOf(undefined), null)
  })
})

describe('headReviewed', () => {
  it('reads the sha on its own line, any case, optional backticks', () => {
    assert.equal(headReviewed(`VERDICT: MERGE\r\nHead reviewed: ${HEAD}\r\n`), HEAD)
    assert.equal(headReviewed('VERDICT: MERGE\nHead reviewed: `A1B2C3DEEEEE`'), 'a1b2c3deeeee')
  })
  it('needs 12 to 40 hex digits on a line of its own', () => {
    assert.equal(headReviewed('Head reviewed: a1b2c3d'), null)
    assert.equal(headReviewed('Head reviewed: a1b2c3deeee'), null)
    assert.equal(headReviewed('Head reviewed: the latest'), null)
    assert.equal(headReviewed('see Head reviewed: a1b2c3deeeee'), null)
    assert.equal(headReviewed('> Head reviewed: a1b2c3deeeee'), null)
  })
})

describe('contextFor', () => {
  it('gates prod (required) and dev (informational) only', () => {
    assert.equal(contextFor('prod'), 'review-verdict')
    assert.equal(contextFor('dev'), 'review-verdict/dev')
    for (const base of ['lab/elara-study', 'main', 'constructor', '__proto__', '']) assert.equal(contextFor(base), null)
  })
})

describe('gateFor', () => {
  const REPO = 'PIIIX-org/chapters'
  const prTo = (base, headRepo = REPO, state = 'open') => ({
    number: 700,
    state,
    base: { ref: base },
    head: { sha: HEAD, repo: headRepo ? { full_name: headRepo } : null },
  })
  it('sets the base context for open same-repo PRs to prod and dev', () => {
    assert.deepEqual(gateFor(prTo('prod'), REPO), { context: 'review-verdict' })
    assert.deepEqual(gateFor(prTo('dev'), REPO), { context: 'review-verdict/dev' })
  })
  it('never sets a status for a fork PR, even one to prod with the promotion head', () => {
    assert.match(gateFor(prTo('prod', 'someone/chapters'), REPO).skip, /comes from someone\/chapters; fork PRs get no status/)
    assert.match(gateFor(prTo('prod', null), REPO).skip, /a deleted fork/)
  })
  it('skips other bases and closed PRs', () => {
    assert.match(gateFor(prTo('lab/elara-study'), REPO).skip, /no review gate/)
    assert.match(gateFor(prTo('prod', REPO, 'closed'), REPO).skip, /is closed/)
  })
})

describe('merge queue', () => {
  const BASE = 'c'.repeat(40)
  it('reads the PR number of the queue branch; the sha in it is the base, not the head', () => {
    assert.equal(mergeGroupPr(`refs/heads/gh-readonly-queue/dev/pr-1050-${BASE}`), 1050)
    assert.equal(mergeGroupPr(`refs/heads/gh-readonly-queue/prod/pr-7-${BASE.slice(0, 7)}`), 7)
    assert.equal(mergeGroupPr('refs/heads/fix/pr-12-abcdef0'), null)
    assert.equal(mergeGroupPr(`refs/heads/gh-readonly-queue/dev/pr-12`), null)
    assert.equal(mergeGroupPr(undefined), null)
  })
  it('accepts a queue merge commit whose second parent is the PR head', () => {
    assert.deepEqual(queueContains({ parents: [{ sha: BASE }, { sha: HEAD }], baseSha: BASE, prHead: HEAD }), { ok: true })
    assert.deepEqual(queueContains({ parents: [{ sha: HEAD }, { sha: BASE }], baseSha: BASE, prHead: HEAD }), { ok: true })
  })
  it('refuses a queue commit built from another head, naming it', () => {
    assert.deepEqual(queueContains({ parents: [{ sha: BASE }, { sha: OLD }], baseSha: BASE, prHead: HEAD }), { ok: false, contains: OLD })
  })
  it('cannot verify a commit that is not a merge and says so', () => {
    assert.deepEqual(queueContains({ parents: [{ sha: BASE }], baseSha: BASE, prHead: HEAD }), { ok: true, unverified: true })
    assert.deepEqual(queueContains({ parents: [], baseSha: BASE, prHead: HEAD }), { ok: true, unverified: true })
  })
})

describe('reviewLinks', () => {
  it('finds URLs and Elara links', () => {
    assert.deepEqual(reviewLinks(`VERDICT: MERGE\nReview: ${RECORD}.`), [RECORD])
    assert.deepEqual(reviewLinks('VERDICT: MERGE\nReview: [[reviews/700]]'), ['[[reviews/700]]'])
    assert.deepEqual(reviewLinks(`see [record](${RECORD})`), [RECORD])
  })
  it('does not count the PR itself as a record', () => {
    assert.deepEqual(reviewLinks(`${PR_URL} ${PR_URL}/files ${PR_URL}#issuecomment-1`, PR_URL), [])
    assert.deepEqual(reviewLinks(`${PR_URL}0`, PR_URL), [`${PR_URL}0`])
  })
  it('a bare path or #number is not a link', () => {
    assert.deepEqual(reviewLinks('VERDICT: MERGE\nreviews/700.md, #700'), [])
  })
})

describe('headSince', () => {
  it('takes the latest of commit date, first seen and force-push', () => {
    assert.deepEqual(
      headSince({
        commitDate: '2026-10-01T00:00:00Z',
        firstSeen: '2026-10-16T10:05:00Z',
        forcePushed: '2026-10-16T09:00:00Z',
      }),
      { at: Date.parse('2026-10-16T10:05:00Z'), source: 'first seen' },
    )
    assert.equal(headSince({ commitDate: 'x', forcePushed: '2026-10-16T09:00:00Z' }).source, 'force-push')
    assert.deepEqual(headSince({}), { at: null, source: 'unknown' })
  })
})

describe('evaluate', () => {
  it('fails with no review and no verdict, and says how to pass', () => {
    const v = run({})
    assert.equal(v.ok, false)
    assert.match(v.description, /^No review of a1b2c3d/)
    assert.match(v.report, /first line is exactly `VERDICT: MERGE`/)
    assert.match(v.report, new RegExp(`Head reviewed: ${HEAD}`))
  })

  it('fails on VERDICT: CHANGES', () => {
    const v = run({ comments: [comment('VERDICT: CHANGES\n1. x', '2026-10-16T11:00:00Z')] })
    assert.equal(v.ok, false)
    assert.match(v.description, /VERDICT: CHANGES/)
  })

  it('fails on VERDICT: MERGE posted before the head', () => {
    const v = run({ comments: [comment(merge, '2026-10-16T09:59:59Z')] })
    assert.equal(v.ok, false)
    assert.match(v.description, /^Review predates head a1b2c3d/)
    assert.match(v.report, /predates the head/)
  })

  it('passes on VERDICT: MERGE that names the head and links a record, after the head', () => {
    const v = run({ comments: [comment(merge, '2026-10-16T10:00:01Z')] })
    assert.equal(v.ok, true, v.report)
    assert.equal(v.description, 'VERDICT: MERGE by @Taha-Mahmoodi on a1b2c3d')
    assert.match(v.report, /Review record: https:\/\/github\.com\/PIIIX-org\/chapters\/issues\/574/)
  })

  it('fails on VERDICT: MERGE without a Head reviewed line, or naming another commit', () => {
    const none = run({ comments: [comment(`VERDICT: MERGE\nReview: ${RECORD}`, '2026-10-16T11:00:00Z')] })
    assert.equal(none.ok, false)
    assert.match(none.description, /has no "Head reviewed: <sha>" line/)
    const other = run({
      comments: [comment(`VERDICT: MERGE\nReview: ${RECORD}\nHead reviewed: ${OLD}`, '2026-10-16T11:00:00Z')],
    })
    assert.equal(other.ok, false)
    assert.match(other.description, /names bbbbbbb, not the head a1b2c3d/)
  })

  it('a backdated commit pushed after the verdict makes it stale', () => {
    const pushedLater = headSince({ commitDate: '2026-10-16T08:00:00Z', firstSeen: '2026-10-16T12:00:00Z' })
    const v = run({ since: pushedLater, comments: [comment(merge, '2026-10-16T11:00:00Z')] })
    assert.equal(v.ok, false)
  })

  it('fails on VERDICT: MERGE without a review record', () => {
    const v = run({
      comments: [
        comment(`VERDICT: MERGE\nHead reviewed: ${HEAD}\nLooks good, see ${PR_URL}/files`, '2026-10-16T11:00:00Z'),
      ],
    })
    assert.equal(v.ok, false)
    assert.match(v.description, /links no review record/)
  })

  it('the latest verdict after the head decides', () => {
    const changesLast = run({
      comments: [comment(merge, '2026-10-16T11:00:00Z'), comment('VERDICT: CHANGES', '2026-10-16T12:00:00Z')],
    })
    assert.equal(changesLast.ok, false)
    // Comment order from the API is not trusted; created_at decides.
    const mergeLast = run({
      comments: [comment(merge, '2026-10-16T12:00:00Z'), comment('VERDICT: CHANGES', '2026-10-16T11:00:00Z')],
    })
    assert.equal(mergeLast.ok, true, mergeLast.report)
  })

  it('ignores verdicts from users without write permission and from bots', () => {
    for (const [user, reason] of [
      [{ login: 'stranger', type: 'User' }, 'no write access'],
      [{ login: 'org-member-read-only', type: 'User' }, 'no write access'],
      [{ login: 'reviewer', type: 'Bot' }, 'a bot'],
    ]) {
      const v = run({ comments: [comment(merge, '2026-10-16T11:00:00Z', { user })] })
      assert.equal(v.ok, false, JSON.stringify(user))
      assert.match(v.report, new RegExp(`ignored: ${reason}`))
    }
  })

  it('reports a failed permission lookup as such, and does not count it', () => {
    const v = evaluate({
      pr,
      since,
      writers: new Set(),
      lookupFailed: new Set(['Taha-Mahmoodi']),
      comments: [comment(merge, '2026-10-16T11:00:00Z')],
    })
    assert.equal(v.ok, false)
    assert.match(v.report, /ignored: permission lookup failed/)
  })

  it('passes on an approval of the head by someone else with write permission', () => {
    const v = run({ reviews: [review('APPROVED', HEAD, '2026-10-16T11:00:00Z')] })
    assert.equal(v.ok, true, v.report)
    assert.equal(v.description, 'Approved on a1b2c3d by @reviewer')
  })

  it('an approval of an older commit, by a non-writer, by a bot or by the author does not count', () => {
    for (const r of [
      review('APPROVED', OLD, '2026-10-16T09:00:00Z'),
      review('APPROVED', HEAD, '2026-10-16T11:00:00Z', 'stranger'),
      review('APPROVED', HEAD, '2026-10-16T11:00:00Z', 'reviewer', 'Bot'),
      review('APPROVED', HEAD, '2026-10-16T11:00:00Z', 'Taha-Mahmoodi'),
      review('COMMENTED', HEAD, '2026-10-16T11:00:00Z'),
    ]) {
      assert.equal(run({ reviews: [r] }).ok, false, JSON.stringify(r))
    }
  })

  it("a reviewer's later CHANGES_REQUESTED or DISMISSED replaces their approval", () => {
    const changes = run({
      reviews: [
        review('CHANGES_REQUESTED', HEAD, '2026-10-16T12:00:00Z'),
        review('APPROVED', HEAD, '2026-10-16T11:00:00Z'),
      ],
      comments: [comment(merge, '2026-10-16T13:00:00Z')],
    })
    assert.equal(changes.ok, false)
    assert.match(changes.description, /^Changes requested by @reviewer/)
    const dismissed = run({
      reviews: [review('APPROVED', HEAD, '2026-10-16T11:00:00Z'), review('DISMISSED', HEAD, '2026-10-16T12:00:00Z')],
    })
    assert.equal(dismissed.ok, false)
  })

  it('a VERDICT: CHANGES after the head blocks an approval', () => {
    const v = run({
      reviews: [review('APPROVED', HEAD, '2026-10-16T11:00:00Z')],
      comments: [comment('VERDICT: CHANGES', '2026-10-16T12:00:00Z')],
    })
    assert.equal(v.ok, false)
  })

  it('fails closed when the head time is unknown', () => {
    const v = run({ since: headSince({}), comments: [comment(merge, '2026-10-16T11:00:00Z')] })
    assert.equal(v.ok, false)
  })

  it('keeps the status description within 140 characters', () => {
    const v = evaluate({
      pr: { ...pr, user: { login: 'x' } },
      since,
      writers: new Set(['r'.repeat(200)]),
      reviews: [review('CHANGES_REQUESTED', HEAD, '2026-10-16T11:00:00Z', 'r'.repeat(200))],
    })
    assert.ok(v.description.length <= 140)
  })
})
