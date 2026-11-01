// Unit tests for the pure parts of issue-close-check.mjs.
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  COMMENT_MARKER,
  acceptanceItems,
  check,
  closingRefs,
  contentWords,
  defectEntriesFor,
  isTransient,
  mentions,
  mergeGroupPr,
  proseLines,
  refersTo,
  retryDelay,
  titleIssueRefs,
} from './issue-close-check.mjs'

const REPO = 'PIIIX-org/chapters'
const SHA = 'dd2e1c9f0a1b2c3d4e5f60718293a4b5c6d7e8f9'

// --- fixtures ---------------------------------------------------------------

/** An issue with a `Done when` line, a checklist and a section. */
const ISSUE_CHECKLIST = {
  number: 710,
  title: 'User-facing release notes for each promotion',
  state: 'open',
  html_url: 'https://github.com/PIIIX-org/chapters/issues/710',
  body: [
    '**Problem:** nobody can tell what a promotion changed.',
    '',
    '**Done when:** the phase-1 promotion has an entry and the promotion procedure includes writing it.',
    '',
    '- [ ] CHANGELOG entry per promotion',
    '- [x] decided where it lives (GitHub Releases)',
    '- [ ] rollback notes for migrations `0019`/`0020`',
    '',
    '## Done when',
    '',
    'The promotion PR template links the entry.',
    '',
    '<!-- - [ ] a commented-out item -->',
    '```',
    '- [ ] an item inside code',
    '```',
  ].join('\n'),
}

/** An open issue with no checklist at all. */
const ISSUE_PLAIN = {
  number: 1044,
  title: 'Deleters can deadlock',
  state: 'open',
  html_url: 'https://github.com/PIIIX-org/chapters/issues/1044',
  body: 'Two deleters hold different advisory locks.\n\nFix options: serialize or fixed row order.',
}

const ISSUE_CLOSED = {
  number: 403,
  title: 'Sequential edit_note credited to the wrong actor',
  state: 'closed',
  state_reason: 'completed',
  html_url: 'https://github.com/PIIIX-org/chapters/issues/403',
  body: '- [ ] attribution of sequential edits',
}

/** The API returns pull requests from /issues/{n} too, with a `pull_request` key. */
const ISSUE_IS_PR = {
  number: 1046,
  title: 'feat: symbol-level code edges',
  state: 'closed',
  html_url: 'https://github.com/PIIIX-org/chapters/pull/1046',
  pull_request: {
    url: 'https://api.github.com/repos/PIIIX-org/chapters/pulls/1046',
  },
  body: '',
}

const DEFECTS = {
  defects: [
    {
      test: 'fix-attribution',
      check: 'sequential edit_note credited to the MCP connection',
      issue: 403,
    },
    {
      test: 'crash-write',
      match: '^kill \\S+: check-notes clean$',
      issue: '486',
    },
    {
      test: 'attachments',
      check: 'an attachment can be deleted at all (REST)',
      issue: 561,
    },
  ],
}

const pr = (body, title = 'docs: something', extra = {}) => ({
  number: 1050,
  title,
  body,
  html_url: 'https://github.com/PIIIX-org/chapters/pull/1050',
  head: { sha: SHA },
  ...extra,
})

/** A body that answers every item of ISSUE_CHECKLIST. */
const BODY_FULL = [
  '## Change',
  '',
  'Adds a CHANGELOG entry per promotion, written by the promotion procedure;',
  'the phase-1 promotion has an entry. Rollback notes for migrations `0019`/`0020`',
  'are part of the entry. The promotion PR template links the entry.',
  '',
  'Closes #710',
].join('\n')

// --- proseLines / closingRefs / titleIssueRefs --------------------------------

describe('proseLines', () => {
  it('drops fenced code, inline code and HTML comments but keeps line count', () => {
    const body = 'a `x` b <!-- c\nd --> e\n```\nf\n```\ng'
    assert.deepEqual(proseLines(body), ['a  b ', ' e', '', '', '', 'g'])
    assert.deepEqual(proseLines(body, { inlineCode: true }), [
      'a `x` b ',
      ' e',
      '',
      '',
      '',
      'g',
    ])
  })
})

describe('closingRefs', () => {
  it('finds every closing keyword form, once each, same repo flagged', () => {
    const body = [
      'Closes #12, closes #12 again. Fixes: PIIIX-org/chapters#13.',
      'Resolved https://github.com/PIIIX-org/chapters/issues/14',
      'resolves https://github.com/other/repo/issues/9',
      'fix #15',
    ].join('\n')
    assert.deepEqual(closingRefs(body, REPO), [
      { number: 12, repo: 'piiix-org/chapters', sameRepo: true },
      { number: 13, repo: 'piiix-org/chapters', sameRepo: true },
      { number: 14, repo: 'piiix-org/chapters', sameRepo: true },
      { number: 9, repo: 'other/repo', sameRepo: false },
      { number: 15, repo: 'piiix-org/chapters', sameRepo: true },
    ])
  })

  it('ignores the template placeholder, code, comments and plain mentions', () => {
    const body =
      'Closes #\n\nrefs #7, see #8.\n`Closes #9`\n<!-- Fixes #10 -->\n```\nResolves #11\n```\nprefix #12'
    assert.deepEqual(closingRefs(body, REPO), [])
    assert.deepEqual(closingRefs(null, REPO), [])
  })
})

describe('titleIssueRefs', () => {
  it('reads #N from a title, not HTML entities', () => {
    assert.deepEqual(
      titleIssueRefs('fix: code ranks above docs (#457) and #12, #457'),
      [457, 12],
    )
    assert.deepEqual(titleIssueRefs('docs: a &#39;quote&#39;'), [])
    assert.deepEqual(titleIssueRefs(undefined), [])
  })
})

// --- (a) acceptance items and mentions ---------------------------------------

describe('acceptanceItems', () => {
  it('lists Done-when text, unchecked items and section paragraphs; skips checked, code, comments', () => {
    assert.deepEqual(acceptanceItems(ISSUE_CHECKLIST.body), [
      'the phase-1 promotion has an entry and the promotion procedure includes writing it.',
      'CHANGELOG entry per promotion',
      'rollback notes for migrations 0019/0020',
      'The promotion PR template links the entry.',
    ])
  })

  it('reads a Done when heading of any level with a list, and de-duplicates', () => {
    const body =
      '### Done when:\n\n- [ ] one\n* two\n1. [x] three\n\n## Later\n\n- [ ] one\n- [ ] four'
    assert.deepEqual(acceptanceItems(body), ['one', 'two', 'four'])
  })

  it('returns nothing for an issue without a checklist', () => {
    assert.deepEqual(acceptanceItems(ISSUE_PLAIN.body), [])
    assert.deepEqual(acceptanceItems(null), [])
  })
})

describe('mentions', () => {
  it('accepts the item quoted verbatim, in any case and punctuation', () => {
    assert.equal(
      mentions(
        'Done: **CHANGELOG entry per promotion**.',
        'CHANGELOG entry per promotion',
      ),
      true,
    )
    assert.equal(
      mentions(
        'rollback notes for migrations 0019',
        'rollback notes for migrations `0019`/`0020`',
      ),
      true,
    )
  })

  it('accepts two thirds of the content words and rejects fewer', () => {
    const item =
      'the phase-1 promotion has an entry and the promotion procedure includes writing it'
    assert.deepEqual(contentWords(item), [
      'phase',
      'promotion',
      'entry',
      'procedure',
      'includes',
      'writing',
    ])
    assert.equal(
      mentions('the promotion entry is written by the procedure', item),
      false,
    ) // 3 of 6
    assert.equal(
      mentions('the promotion procedure now includes an entry', item),
      true,
    ) // 4 of 6
    assert.equal(mentions('unrelated body', item), false)
  })

  it('ignores the body template comments and code fences, counts inline code', () => {
    assert.equal(
      mentions(
        '<!-- CHANGELOG entry per promotion -->',
        'CHANGELOG entry per promotion',
      ),
      false,
    )
    assert.equal(
      mentions(
        '```\nCHANGELOG entry per promotion\n```',
        'CHANGELOG entry per promotion',
      ),
      false,
    )
    assert.equal(
      mentions(
        'see `docs/CHANGELOG.md` entry per promotion',
        'CHANGELOG entry per promotion',
      ),
      true,
    )
  })
})

// --- (b) known defects --------------------------------------------------------

describe('defectEntriesFor', () => {
  it('matches numeric and string issue fields', () => {
    assert.deepEqual(defectEntriesFor(DEFECTS, 403), [
      {
        test: 'fix-attribution',
        check: 'sequential edit_note credited to the MCP connection',
        match: undefined,
      },
    ])
    assert.deepEqual(defectEntriesFor(DEFECTS, 486), [
      {
        test: 'crash-write',
        check: undefined,
        match: '^kill \\S+: check-notes clean$',
      },
    ])
    assert.deepEqual(defectEntriesFor(DEFECTS, 1), [])
    assert.deepEqual(defectEntriesFor({}, 403), [])
  })
})

// --- merge group -------------------------------------------------------------

describe('mergeGroupPr', () => {
  it('reads the PR number from the queue branch, with or without refs/heads/', () => {
    assert.equal(mergeGroupPr(`gh-readonly-queue/dev/pr-1050-${SHA}`), 1050)
    assert.equal(
      mergeGroupPr(`refs/heads/gh-readonly-queue/dev/pr-7-${SHA}`),
      7,
    )
    assert.equal(mergeGroupPr('ci/issue-close-check'), null)
    assert.equal(mergeGroupPr(undefined), null)
  })
})

describe('retry', () => {
  const h = (o = {}) => new Headers(o)
  it('retries once on 5xx, 429 and the rate-limit 403, not on other 4xx', () => {
    assert.equal(isTransient(502, h()), true)
    assert.equal(isTransient(429, h()), true)
    assert.equal(isTransient(403, h({ 'x-ratelimit-remaining': '0' })), true)
    assert.equal(isTransient(403, h({ 'retry-after': '3' })), true)
    assert.equal(isTransient(403, h({ 'x-ratelimit-remaining': '41' })), false)
    assert.equal(isTransient(404, h()), false)
    assert.equal(isTransient(422, h()), false)
  })
  it('waits retry-after (capped at 60 s), else 5 s', () => {
    assert.equal(retryDelay(h({ 'retry-after': '3' })), 3)
    assert.equal(retryDelay(h({ 'retry-after': '600' })), 60)
    assert.equal(retryDelay(h({ 'retry-after': 'soon' })), 5)
    assert.equal(retryDelay(h()), 5)
  })
})

// --- check: the verdict --------------------------------------------------------

describe('check', () => {
  it('no-op: a PR that closes nothing passes with no comment', () => {
    const r = check({
      pr: pr('## Change\n\nDocs.\n\nCloses #'),
      issues: {},
      defects: DEFECTS,
      repo: REPO,
    })
    assert.equal(r.ok, true)
    assert.deepEqual(r.refs, [])
    assert.deepEqual(r.warnings, [])
    assert.equal(r.comment, null)
    assert.match(r.title, /closes no issue/)
  })

  it('(a) passes when every acceptance item is mentioned, and the comment lists them', () => {
    const r = check({
      pr: pr(BODY_FULL),
      issues: { 710: ISSUE_CHECKLIST },
      defects: DEFECTS,
      repo: REPO,
    })
    assert.equal(r.ok, true, r.report)
    assert.deepEqual(
      r.issues[0].items.map((i) => i.mentioned),
      [true, true, true, true],
    )
    assert.ok(
      r.comment.startsWith(`${COMMENT_MARKER}\n## Issue close check: passed`),
    )
    assert.match(r.comment, /- mentioned: CHANGELOG entry per promotion/)
    assert.doesNotMatch(r.comment, /not in the PR body/)
    assert.doesNotMatch(r.comment, /\*\*Author:\*\*/)
    assert.match(r.comment, new RegExp(`Head: \`${SHA}\``))
  })

  it('(a) an unmentioned item is a warning and an author request, never a failure', () => {
    const body = 'Adds a CHANGELOG entry per promotion.\n\nCloses #710'
    const r = check({
      pr: pr(body),
      issues: { 710: ISSUE_CHECKLIST },
      defects: DEFECTS,
      repo: REPO,
    })
    assert.equal(r.ok, true)
    assert.deepEqual(r.issues[0].problems, [])
    assert.equal(r.issues[0].unmentioned, 3)
    assert.deepEqual(
      r.issues[0].items.filter((i) => !i.mentioned).map((i) => i.text),
      [
        'the phase-1 promotion has an entry and the promotion procedure includes writing it.',
        'rollback notes for migrations 0019/0020',
        'The promotion PR template links the entry.',
      ],
    )
    assert.deepEqual(r.warnings, [
      '3 acceptance items of #710 are not mentioned in the PR body (see the comment).',
    ])
    assert.match(
      r.title,
      /3 acceptance items are not mentioned in the body \(a warning, not a failure\)/,
    )
    assert.ok(
      r.comment.startsWith(`${COMMENT_MARKER}\n## Issue close check: passed`),
    )
    assert.match(
      r.comment,
      /:warning: 3 acceptance items not mentioned in the PR body/,
    )
    assert.match(
      r.comment,
      /\*\*not in the PR body\*\*: rollback notes for migrations/,
    )
    assert.match(r.comment, /\*\*Author:\*\* for each item marked/)
    assert.match(r.comment, /not a gate: the check does not fail on it/)
    // The warning is for the annotation only; the report lists it once, under the issue.
    assert.equal(
      (r.report.match(/not mentioned in the PR body/g) ?? []).length,
      1,
    )
  })

  it('neutralises @mentions copied from issue text so the comment pings nobody', () => {
    const issue = {
      ...ISSUE_PLAIN,
      title: 'Ask @octocat about locks',
      body: '- [ ] ping @octocat and @some-team/reviewers',
    }
    const r = check({
      pr: pr('Closes #1044'),
      issues: { 1044: issue },
      defects: DEFECTS,
      repo: REPO,
    })
    assert.doesNotMatch(r.comment, /@octocat/)
    assert.doesNotMatch(r.comment, /@some-team/)
    assert.match(r.comment, /@\u200Doctocat/)
    assert.match(r.comment, /@\u200Dsome-team\/reviewers/)
  })

  it('a merged or closed PR is skipped: passes, no refs, comment left alone', () => {
    for (const extra of [
      { state: 'closed', merged: true },
      { state: 'closed', merged: false },
    ]) {
      const r = check({
        pr: pr('Closes #403', 'fix: x', extra),
        issues: { 403: ISSUE_CLOSED },
        defects: DEFECTS,
        repo: REPO,
      })
      assert.equal(r.ok, true)
      assert.equal(r.skipped, true)
      assert.deepEqual(r.issues, [])
      assert.equal(r.comment, undefined)
      assert.match(
        r.title,
        extra.merged ? /#1050 is merged/ : /#1050 is closed/,
      )
    }
    assert.equal(
      check({
        pr: pr('Closes #1044', 'x', { state: 'open', merged: false }),
        issues: { 1044: ISSUE_PLAIN },
        defects: DEFECTS,
        repo: REPO,
      }).skipped,
      false,
    )
  })

  it('(a) an issue without a checklist passes and says so', () => {
    const r = check({
      pr: pr('Closes #1044'),
      issues: { 1044: ISSUE_PLAIN },
      defects: DEFECTS,
      repo: REPO,
    })
    assert.equal(r.ok, true)
    assert.deepEqual(r.issues[0].items, [])
    assert.match(
      r.comment,
      /no `Done when` section and no unchecked checklist item/,
    )
  })

  it('(b) fails when lab/known-defects.json still points at the issue', () => {
    const open403 = { ...ISSUE_CLOSED, state: 'open', body: '' }
    const r = check({
      pr: pr('Fixes #403'),
      issues: { 403: open403 },
      defects: DEFECTS,
      repo: REPO,
    })
    assert.equal(r.ok, false)
    assert.deepEqual(r.issues[0].problems, [
      '`lab/known-defects.json` still has 1 entry for #403; remove it in this PR (lab.md, rule 5).',
    ])
    assert.match(
      r.comment,
      /`fix-attribution`: `sequential edit_note credited to the MCP connection`/,
    )
    // The same PR with the entry removed passes.
    const fixed = { defects: DEFECTS.defects.filter((d) => d.issue !== 403) }
    assert.equal(
      check({
        pr: pr('Fixes #403'),
        issues: { 403: open403 },
        defects: fixed,
        repo: REPO,
      }).ok,
      true,
    )
  })

  it('(b) an unreadable defects file is a warning, not a pass by accident', () => {
    const r = check({
      pr: pr('Closes #1044'),
      issues: { 1044: ISSUE_PLAIN },
      defects: new Error('Unexpected token'),
      repo: REPO,
    })
    assert.equal(r.ok, true)
    assert.match(
      r.warnings[0],
      /known-defects\.json` could not be read: Unexpected token/,
    )
  })

  it('(c) fails for a closed issue, a pull request and a missing issue', () => {
    const r = check({
      pr: pr('Closes #403, closes #1046, closes #999999'),
      issues: { 403: ISSUE_CLOSED, 1046: ISSUE_IS_PR, 999999: null },
      defects: { defects: [] },
      repo: REPO,
    })
    assert.equal(r.ok, false)
    assert.deepEqual(r.issues[0].problems, [
      '#403 is already closed (completed): a merged PR cannot close it again. Reopen it or drop the closing keyword.',
    ])
    // A closed issue's items are still listed, as a warning.
    assert.equal(r.issues[0].unmentioned, 1)
    assert.deepEqual(r.issues[1].problems, [
      '#1046 is a pull request, not an issue.',
    ])
    assert.deepEqual(r.issues[2].problems, [
      '#999999 does not exist in `PIIIX-org/chapters`.',
    ])
    assert.equal(r.issues[2].state, 'missing')
    assert.match(r.title, /3 of the 3 issues the PR closes have a problem/)
  })

  it('(d) warns, and passes, when only the title names an issue', () => {
    const r = check({
      pr: pr(
        '## Change\n\nRanks code first, see the plan note.',
        'fix: code ranks above docs (#457)',
      ),
      issues: {},
      defects: DEFECTS,
      repo: REPO,
    })
    assert.equal(r.ok, true)
    assert.equal(r.warnings.length, 1)
    assert.match(
      r.warnings[0],
      /title names #457 but the body has no closing keyword/,
    )
    assert.match(r.comment, /:warning: The title names #457/)
    assert.match(r.title, /see the warnings/)
  })

  it('(d) is quiet when the body refers to the issue on purpose', () => {
    for (const body of [
      'Refs #457.',
      'refs: #457',
      'Related to #457',
      'part of PIIIX-org/chapters#457',
      'See #457',
    ]) {
      const r = check({
        pr: pr(body, 'fix: code ranks (#457)'),
        issues: {},
        defects: DEFECTS,
        repo: REPO,
      })
      assert.deepEqual(r.warnings, [], body)
      assert.equal(r.comment, null, body)
    }
    assert.equal(refersTo('Refs #457', 457), true)
    assert.equal(refersTo('Refs #4570', 457), false)
    assert.equal(refersTo('`refs #457`', 457), false)
    assert.equal(refersTo('#457 is the plan', 457), false)
  })

  it('(d) does not warn when the body does close something', () => {
    const r = check({
      pr: pr('Closes #1044', 'fix: deadlock (#1044)'),
      issues: { 1044: ISSUE_PLAIN },
      defects: DEFECTS,
      repo: REPO,
    })
    assert.deepEqual(r.warnings, [])
  })

  it('another repository is warned about, not checked', () => {
    const r = check({
      pr: pr('Closes other/repo#9'),
      issues: {},
      defects: DEFECTS,
      repo: REPO,
    })
    assert.equal(r.ok, true)
    assert.deepEqual(r.issues, [])
    assert.match(
      r.warnings[0],
      /`other\/repo#9` is in another repository and is not checked/,
    )
  })

  it('is deterministic: the same inputs give the same comment', () => {
    const args = {
      pr: pr(BODY_FULL),
      issues: { 710: ISSUE_CHECKLIST },
      defects: DEFECTS,
      repo: REPO,
    }
    assert.equal(check(args).comment, check(args).comment)
    assert.equal(check(args).report, check(args).report)
  })
})
