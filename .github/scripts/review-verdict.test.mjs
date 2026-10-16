// Unit tests for the pure parts of review-verdict.mjs (#574).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluate, headSince, reviewLinks, verdictOf } from './review-verdict.mjs'

const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const PR_URL = 'https://github.com/PIIIX-org/chapters/pull/700'
const RECORD = 'https://gist.github.com/Taha-Mahmoodi/0123456789abcdef'
const pr = { user: { login: 'Taha-Mahmoodi' }, head: { sha: HEAD }, html_url: PR_URL }
const since = headSince({ commitDate: '2026-10-16T10:00:00Z' })

let id = 0
const comment = (body, created_at, over = {}) => ({
  body,
  created_at,
  user: { login: 'Taha-Mahmoodi', type: 'User' },
  author_association: 'OWNER',
  html_url: `${PR_URL}#issuecomment-${++id}`,
  ...over,
})
const review = (state, commit_id, submitted_at, login = 'reviewer', over = {}) => ({
  state,
  commit_id,
  submitted_at,
  user: { login },
  author_association: 'COLLABORATOR',
  ...over,
})
const merge = `VERDICT: MERGE\n\nReview: ${RECORD}`

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
    const v = evaluate({ pr, since })
    assert.equal(v.ok, false)
    assert.match(v.description, /^No review of aaaaaaa/)
    assert.match(v.report, /first line is exactly `VERDICT: MERGE`/)
  })

  it('fails on VERDICT: CHANGES', () => {
    const v = evaluate({ pr, since, comments: [comment('VERDICT: CHANGES\n1. x', '2026-10-16T11:00:00Z')] })
    assert.equal(v.ok, false)
    assert.match(v.description, /VERDICT: CHANGES/)
  })

  it('fails on VERDICT: MERGE posted before the head', () => {
    const v = evaluate({ pr, since, comments: [comment(merge, '2026-10-16T09:59:59Z')] })
    assert.equal(v.ok, false)
    assert.match(v.description, /^Review predates head aaaaaaa/)
    assert.match(v.report, /predates the head/)
  })

  it('passes on VERDICT: MERGE with a record after the head', () => {
    const v = evaluate({ pr, since, comments: [comment(merge, '2026-10-16T10:00:01Z')] })
    assert.equal(v.ok, true, v.report)
    assert.equal(v.description, 'VERDICT: MERGE by @Taha-Mahmoodi after aaaaaaa')
    assert.match(v.report, /Review record: https:\/\/gist/)
  })

  it('a backdated commit pushed after the verdict makes it stale', () => {
    const pushedLater = headSince({ commitDate: '2026-10-16T08:00:00Z', firstSeen: '2026-10-16T12:00:00Z' })
    const v = evaluate({ pr, since: pushedLater, comments: [comment(merge, '2026-10-16T11:00:00Z')] })
    assert.equal(v.ok, false)
  })

  it('fails on VERDICT: MERGE without a review record', () => {
    const v = evaluate({
      pr,
      since,
      comments: [comment(`VERDICT: MERGE\nLooks good, see ${PR_URL}/files`, '2026-10-16T11:00:00Z')],
    })
    assert.equal(v.ok, false)
    assert.match(v.description, /links no review record/)
  })

  it('the latest verdict after the head decides', () => {
    const changesLast = evaluate({
      pr,
      since,
      comments: [comment(merge, '2026-10-16T11:00:00Z'), comment('VERDICT: CHANGES', '2026-10-16T12:00:00Z')],
    })
    assert.equal(changesLast.ok, false)
    // Comment order from the API is not trusted; created_at decides.
    const mergeLast = evaluate({
      pr,
      since,
      comments: [comment(merge, '2026-10-16T12:00:00Z'), comment('VERDICT: CHANGES', '2026-10-16T11:00:00Z')],
    })
    assert.equal(mergeLast.ok, true, mergeLast.report)
  })

  it('ignores verdicts from users without write access and from bots', () => {
    for (const over of [
      { author_association: 'NONE', user: { login: 'stranger', type: 'User' } },
      { author_association: 'CONTRIBUTOR', user: { login: 'ex-contributor', type: 'User' } },
      { author_association: 'MEMBER', user: { login: 'some-bot[bot]', type: 'Bot' } },
    ]) {
      const v = evaluate({ pr, since, comments: [comment(merge, '2026-10-16T11:00:00Z', over)] })
      assert.equal(v.ok, false, JSON.stringify(over))
    }
  })

  it('passes on an approval of the head by someone else with write access', () => {
    const v = evaluate({ pr, since, reviews: [review('APPROVED', HEAD, '2026-10-16T11:00:00Z')] })
    assert.equal(v.ok, true, v.report)
    assert.equal(v.description, 'Approved on aaaaaaa by @reviewer')
  })

  it('an approval of an older commit, by a stranger or by the author does not count', () => {
    for (const r of [
      review('APPROVED', OLD, '2026-10-16T09:00:00Z'),
      review('APPROVED', HEAD, '2026-10-16T11:00:00Z', 'stranger', { author_association: 'NONE' }),
      review('APPROVED', HEAD, '2026-10-16T11:00:00Z', 'Taha-Mahmoodi', { author_association: 'OWNER' }),
      review('COMMENTED', HEAD, '2026-10-16T11:00:00Z'),
    ]) {
      assert.equal(evaluate({ pr, since, reviews: [r] }).ok, false, JSON.stringify(r))
    }
  })

  it("a reviewer's later CHANGES_REQUESTED or DISMISSED replaces their approval", () => {
    const changes = evaluate({
      pr,
      since,
      reviews: [
        review('CHANGES_REQUESTED', HEAD, '2026-10-16T12:00:00Z'),
        review('APPROVED', HEAD, '2026-10-16T11:00:00Z'),
      ],
      comments: [comment(merge, '2026-10-16T13:00:00Z')],
    })
    assert.equal(changes.ok, false)
    assert.match(changes.description, /^Changes requested by @reviewer/)
    const dismissed = evaluate({
      pr,
      since,
      reviews: [review('APPROVED', HEAD, '2026-10-16T11:00:00Z'), review('DISMISSED', HEAD, '2026-10-16T12:00:00Z')],
    })
    assert.equal(dismissed.ok, false)
  })

  it('a VERDICT: CHANGES after the head blocks an approval', () => {
    const v = evaluate({
      pr,
      since,
      reviews: [review('APPROVED', HEAD, '2026-10-16T11:00:00Z')],
      comments: [comment('VERDICT: CHANGES', '2026-10-16T12:00:00Z')],
    })
    assert.equal(v.ok, false)
  })

  it('fails closed when the head time is unknown', () => {
    const v = evaluate({ pr, since: headSince({}), comments: [comment(merge, '2026-10-16T11:00:00Z')] })
    assert.equal(v.ok, false)
  })

  it('keeps the status description within 140 characters', () => {
    const long = { ...pr, user: { login: 'x' } }
    const v = evaluate({
      pr: long,
      since,
      reviews: [review('CHANGES_REQUESTED', HEAD, '2026-10-16T11:00:00Z', 'r'.repeat(200))],
    })
    assert.ok(v.description.length <= 140)
  })
})
