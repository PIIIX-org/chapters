// Unit tests for the pure parts of attribution.mjs (#580).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BRANCH_TYPES,
  EXEMPT_LABEL,
  appliesTo,
  check,
  hasCoAuthor,
  isWebFlow,
  trailers,
} from './attribution.mjs'

const REPO = 'PIIIX-org/chapters'
const TRAILER = 'Co-Authored-By: Claude Opus <noreply@anthropic.com>'

const pr = (ref, extra = {}) => ({
  number: 7,
  head: { ref, repo: { full_name: REPO } },
  labels: [],
  ...extra,
})

const ME = { name: 'Taha', email: 'taha@users.noreply.github.com' }
const GITHUB = { name: 'GitHub', email: 'noreply@github.com' }
const SIGNED = { verified: true, reason: 'valid' }
const UNSIGNED = { verified: false, reason: 'unsigned' }

const commit = (sha, message, committer = ME, verification = UNSIGNED) => ({
  sha,
  commit: { message, committer, verification },
})

describe('trailers', () => {
  it('reads the trailer paragraph after the body', () => {
    assert.deepEqual(trailers(`fix: a\n\nBody text.\n\n${TRAILER}\nRefs: #1`), [
      { key: 'Co-Authored-By', value: 'Claude Opus <noreply@anthropic.com>' },
      { key: 'Refs', value: '#1' },
    ])
  })

  it('does not read the subject as a trailer', () => {
    assert.deepEqual(trailers('fix: a subject that looks like a trailer'), [])
    assert.deepEqual(trailers(TRAILER), [])
  })

  it('needs every line of the last paragraph to be a trailer', () => {
    assert.deepEqual(trailers(`fix: a\n\nSome prose.\n${TRAILER}`), [])
  })

  it('handles CRLF, extra blank lines and continuation lines', () => {
    assert.deepEqual(trailers(`fix: a\r\n\r\n\r\nNote: one\r\n  two\r\n`), [
      { key: 'Note', value: 'one two' },
    ])
  })
})

describe('hasCoAuthor', () => {
  it('accepts the trailer in any case, GitHub writes Co-authored-by', () => {
    assert.equal(hasCoAuthor(`fix: a\n\n${TRAILER}`), true)
    assert.equal(hasCoAuthor('fix: a\n\nco-authored-by: Someone <s@example.com>'), true)
  })

  it('refuses a missing, misplaced or malformed trailer', () => {
    assert.equal(hasCoAuthor('fix: a\n\nNo trailer here.'), false)
    assert.equal(hasCoAuthor(`fix: a\n\n${TRAILER}\n\nA paragraph after it.`), false)
    assert.equal(hasCoAuthor('fix: a\n\nCo-Authored-By: Claude Opus'), false)
    assert.equal(hasCoAuthor('fix: a\n\nCo-Authored-By: <noreply@anthropic.com>'), false)
    assert.equal(hasCoAuthor(`fix: a\n\nMentions ${TRAILER} inline.`), false)
  })
})

describe('isWebFlow', () => {
  it('recognises commits GitHub made and signed in its web UI', () => {
    assert.equal(isWebFlow(commit('a', 'Merge', GITHUB, SIGNED)), true)
    assert.equal(isWebFlow(commit('a', 'fix: a')), false)
    assert.equal(isWebFlow(commit('a', 'fix: a', ME, SIGNED)), false)
  })

  it('does not trust a committer email alone', () => {
    assert.equal(isWebFlow(commit('a', 'fix: spoofed', GITHUB)), false)
    assert.equal(isWebFlow(commit('a', 'fix: spoofed', GITHUB, { verified: false, reason: 'bad_email' })), false)
    assert.equal(isWebFlow(commit('a', 'fix: spoofed', GITHUB, { verified: true, reason: 'unknown_key' })), false)
  })
})

describe('appliesTo', () => {
  it('applies to every agent branch type, with / or -', () => {
    for (const t of BRANCH_TYPES) {
      assert.equal(appliesTo(pr(`${t}/x`), REPO).applies, true, `${t}/`)
      assert.equal(appliesTo(pr(`${t}-579-x`), REPO).applies, true, `${t}-`)
    }
  })

  it('skips other branches, forks and the human-only label', () => {
    assert.equal(appliesTo(pr('dev'), REPO).applies, false)
    assert.equal(appliesTo(pr('bot/state-md'), REPO).applies, false)
    assert.equal(appliesTo(pr('dependabot/npm/x'), REPO).applies, false)
    assert.equal(appliesTo(pr('fixes/x'), REPO).applies, false)
    assert.equal(appliesTo(pr('lab/x'), REPO).applies, false)
    assert.equal(appliesTo(pr('fix'), REPO).applies, false)
    assert.equal(
      appliesTo({ ...pr('fix/x'), head: { ref: 'fix/x', repo: { full_name: 'someone/chapters' } } }, REPO).applies,
      false,
    )
    const labelled = appliesTo(pr('fix/x', { labels: [{ name: EXEMPT_LABEL }] }), REPO)
    assert.equal(labelled.applies, false)
    assert.match(labelled.reason, /human-only/)
  })
})

describe('check', () => {
  it('fails on a commit without the trailer and lists it', () => {
    const r = check(
      pr('fix/x'),
      [commit('1111111111111111', `fix: a\n\n${TRAILER}`), commit('2222222222222222', 'fix: forgot it')],
      REPO,
    )
    assert.equal(r.ok, false)
    assert.deepEqual(r.missing, [{ sha: '2222222222222222', subject: 'fix: forgot it' }])
    assert.match(r.report, /\| 222222222222 \| fix: forgot it \|/)
  })

  it('passes when every commit has it, exempting web-flow commits', () => {
    const r = check(
      pr('ci/x'),
      [
        commit('1111111111111111', `ci: a\n\n${TRAILER}`),
        commit('3333333333333333', "Merge branch 'dev' into ci/x", GITHUB, SIGNED),
      ],
      REPO,
    )
    assert.equal(r.ok, true)
    assert.equal(r.skipped, false)
    assert.deepEqual(r.webFlow.map((c) => c.sha), ['3333333333333333'])
  })

  it('flags an unsigned commit that only claims GitHub as committer', () => {
    const r = check(pr('fix-579-x'), [commit('4444444444444444', 'fix: spoofed', GITHUB)], REPO)
    assert.equal(r.ok, false)
    assert.deepEqual(r.missing.map((c) => c.sha), ['4444444444444444'])
  })

  it('is skipped (passes) when the rule does not apply', () => {
    const r = check(pr('fix/x', { labels: [{ name: EXEMPT_LABEL }] }), [commit('2', 'fix: no trailer')], REPO)
    assert.equal(r.ok, true)
    assert.equal(r.skipped, true)
  })

  it('fails when GitHub returned fewer commits than the PR has', () => {
    const r = check(pr('fix/x', { commits: 300 }), [commit('1', `fix: a\n\n${TRAILER}`)], REPO)
    assert.equal(r.ok, false)
    assert.match(r.title, /300 commits/)
  })
})
