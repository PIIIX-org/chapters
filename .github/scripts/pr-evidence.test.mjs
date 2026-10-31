// Unit tests for the pure parts of pr-evidence.mjs (#579).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  check,
  claimsIn,
  evidenceSection,
  evidenceState,
  hasEvidenceLink,
  hasEvidenceUrl,
  isRevert,
  mergeGroupPr,
  parseBody,
  placeholders,
  proseUnits,
  unlinkedClaims,
} from './pr-evidence.mjs'

const REPO = 'PIIIX-org/chapters'
const RUN = 'https://github.com/PIIIX-org/chapters/actions/runs/38816673512'

const goodBody = [
  '## Problem',
  '',
  'Notes with a damaged fence could not be opened (#391).',
  '',
  '## Change',
  '',
  '- Anchor the fence regex.',
  '',
  '## Evidence',
  '',
  `- CI: ${RUN}`,
  '- Fails-before: https://github.com/PIIIX-org/chapters/actions/runs/38816783161',
  '',
  '## Not covered',
  '',
  'Nothing.',
  '',
  'Closes #579',
].join('\n')

const pr = (body, extra = {}) => ({
  title: 'fix(notes): anchor the fence',
  body,
  user: { login: 'Taha-Mahmoodi', type: 'User' },
  base: { ref: 'dev' },
  ...extra,
})

const withEvidence = (text) => `## Evidence\n\n- CI: ${RUN}\n\n## Notes\n\n${text}`
const texts = (body) => proseUnits(body).map((u) => u.text)

describe('parseBody', () => {
  it('drops fenced code, inline code and comments', () => {
    assert.deepEqual(
      parseBody(
        'a <!-- stable --> b `c` <code>d</code> e\n```\nall tests pass\n```\n~~~\nx\n~~~',
      ).lines,
      ['a   b     e'],
    )
  })
  it('strips code before comments, so `<!--` in code opens no comment', () => {
    assert.deepEqual(parseBody('use `<!--` here\nverified').lines, [
      'use   here',
      'verified',
    ])
    assert.deepEqual(
      parseBody('```md\n<!-- draft\n```\n## Evidence\nrun').lines,
      ['## Evidence', 'run'],
    )
  })
  it('hides an unclosed comment to the end, and multi-line comments', () => {
    assert.deepEqual(parseBody('a\n<!-- x\ny\n--> b\nc <!-- z').lines, [
      'a',
      '',
      '',
      '  b',
      'c ',
    ])
  })
  it('collects reference-link definitions', () => {
    const { lines, refs } = parseBody(`text [run][1]\n\n[1]: ${RUN}`)
    assert.deepEqual(lines, ['text [run][1]', ''])
    assert.equal(refs.get('1'), RUN)
  })
})

describe('evidenceSection', () => {
  it('finds a heading section and stops at the next heading of its level', () => {
    const s = evidenceSection(goodBody)
    assert.match(s, /CI: https/)
    assert.doesNotMatch(s, /Nothing/)
  })
  it('keeps deeper subsections inside the section', () => {
    const s = evidenceSection(
      '## Evidence\n\n### CI\n\nrun link here\n\n## Not covered\n\nx',
    )
    assert.match(s, /run link here/)
    assert.doesNotMatch(s, /\bx\b/)
  })
  it('accepts any heading level, case, and Evidence anywhere in the heading', () => {
    assert.ok(evidenceSection('# EVIDENCE\nsee run'))
    assert.ok(evidenceSection('### Evidence (CI and lab)\nsee run'))
    assert.ok(evidenceSection('## Tests / Evidence\nsee run'))
  })
  it('accepts a bold label line, with content on the same line', () => {
    assert.equal(evidenceSection('**Evidence:** see the run'), 'see the run')
    const s = evidenceSection('**Evidence**\n- run one\n\n**Not covered**\n- x')
    assert.match(s, /run one/)
    assert.doesNotMatch(s, /- x/)
  })
  it('is null when there is no section', () => {
    assert.equal(evidenceSection(null), null)
    assert.equal(evidenceSection(''), null)
    assert.equal(evidenceSection('## Problem\n\nThe evidence is clear.'), null)
    assert.equal(evidenceSection('## Evidences\n\nx'), null)
  })
  it('is null when the section holds only comments or whitespace', () => {
    assert.equal(
      evidenceSection('## Evidence\n\n<!-- CI run link -->\n\n## Not covered'),
      null,
    )
    assert.equal(evidenceSection('## Evidence\n\n   \n'), null)
  })
  it('ignores a heading inside a code fence or comment', () => {
    assert.equal(evidenceSection('```md\n## Evidence\nrun\n```'), null)
    assert.equal(evidenceSection('<!--\n## Evidence\nrun\n-->'), null)
  })
})

describe('evidenceState', () => {
  const state = (body, extra) => evidenceState(pr(body, extra), REPO).state
  it('rejects a section with no link into the repo', () => {
    for (const s of [
      'TBD',
      '-',
      'n/a',
      'Tested locally.',
      '### CI',
      'See #579.',
      'https://github.com/other/repo/actions/runs/1',
      'https://github.com/PIIIX-org/chapters/actions/runs/',
    ]) {
      assert.equal(state(`## Evidence\n\n${s}\n\n## Not covered\n\nx`), 'no-link', s)
    }
  })
  it('rejects template placeholders, even next to a real link', () => {
    const r = evidenceState(
      pr(
        [
          '## Evidence',
          '',
          '- CI run: https://github.com/PIIIX-org/chapters/actions/runs/<id>',
          '- Fails-before: n/a because <reason>',
          `- Issue: https://github.com/PIIIX-org/chapters/issues/579`,
        ].join('\n'),
      ),
      REPO,
    )
    assert.deepEqual(r, { state: 'placeholder', placeholders: ['<id>', '<reason>'] })
  })
  it('does not take HTML tags, autolinks or code for placeholders', () => {
    assert.deepEqual(
      placeholders(`<details><summary>x</summary> <br/> <${RUN}> <a href="y">`),
      [],
    )
    assert.equal(
      state(`## Evidence\n\n- CI: ${RUN}\n- \`Fails-before: n/a because <reason>\``),
      'ok',
    )
  })
  it('accepts a section with a run, PR, issue, commit or file URL', () => {
    assert.equal(state(goodBody), 'ok')
    assert.equal(
      state('## Evidence\n\nIssue: https://github.com/PIIIX-org/chapters/issues/579'),
      'ok',
    )
    assert.equal(state(`## Evidence\n\nSee [the run][ci].\n\n[ci]: ${RUN}`), 'ok')
  })
  it('lets a Revert-button PR go without a section', () => {
    const extra = { title: 'Revert "ci: publish after CI"' }
    assert.equal(state('Reverts PIIIX-org/chapters#590', extra), 'revert')
    assert.equal(state('Reverts PIIIX-org/chapters#590'), 'missing')
    assert.ok(isRevert(pr('Reverts PIIIX-org/chapters#590', extra)))
    assert.ok(!isRevert(pr('Undo it', extra)))
  })
})

describe('claimsIn', () => {
  it('finds each claim, case-insensitive', () => {
    const cases = {
      '100% remediated': ['100%', 'remediated'],
      'Coverage is 100 %.': ['100%'],
      '100.0% green.': ['100%'],
      '100 percent green.': ['100%'],
      'Ｃoverage １００％': ['100%'],
      'Verified on staging.': ['verified'],
      'Re-verified the counts.': ['verified'],
      'veri\u200bfied': ['verified'],
      'The feature is fully tested.': ['fully tested'],
      'Fully-tested code.': ['fully tested'],
      'fully covered': ['fully tested'],
      'tested end-to-end': ['tested end-to-end'],
      'End-to-end tested.': ['tested end-to-end'],
      'All tests pass.': ['all tests pass'],
      'all the tests passed': ['all tests pass'],
      'ALL TESTS PASSING': ['all tests pass'],
      'All 49 tests pass.': ['all tests pass', 'N tests pass'],
      'all 137 client test suites pass': ['all tests pass', 'N tests pass'],
      'The tests all pass.': ['all tests pass'],
      '922 tests passing across suites': ['N tests pass'],
      '1,236 server tests passed': ['N tests pass'],
      'Related suites 51/51, lint clean.': ['N/N'],
      '26 pass / 0 fail': ['0 errors'],
      '476/476': ['N/N'],
      'TypeScript check passing with 0 errors': ['0 errors'],
      '0 lint/type errors': ['0 errors'],
      'Zero bugs left.': ['0 errors'],
      'no regressions': ['no regressions'],
      'Bug-free.': ['no regressions'],
      'CI is green.': ['is green'],
      'suite green': ['is green'],
      'This is production-ready.': ['production-ready'],
      'production ready': ['production-ready'],
      'The API is stable now.': ['stable'],
    }
    for (const [text, want] of Object.entries(cases)) {
      assert.deepEqual(claimsIn(text), want, text)
    }
  })
  it('matches whole words and real counts only', () => {
    for (const text of [
      'unverified input',
      'an unstable test',
      'stablecoin',
      '1100% growth',
      '0.100% of rows',
      '1000 notes',
      'all tests passport',
      'unremediated finding',
      'zero bugsy',
      '10 errors fixed',
      'slice 1/2',
      'released 2026/10/16',
      'v1.0/1.0',
      'adds 3 tests for the parser',
      'the green button',
    ]) {
      assert.deepEqual(claimsIn(text), [], text)
    }
  })
  it('skips inline code and URLs', () => {
    assert.deepEqual(claimsIn('the word `stable` is banned'), [])
    assert.deepEqual(claimsIn('``all tests pass`` quoted'), [])
    assert.deepEqual(claimsIn('see https://example.com/stable/verified'), [])
  })
})

describe('hasEvidenceUrl / hasEvidenceLink', () => {
  it('accepts runs, PRs, issues, commits and files of the repo', () => {
    for (const url of [
      RUN,
      'https://github.com/PIIIX-org/chapters/actions/runs/1/job/2',
      'https://github.com/PIIIX-org/chapters/pull/597',
      'https://github.com/PIIIX-org/chapters/pull/597/checks',
      'https://github.com/PIIIX-org/chapters/issues/579',
      'https://github.com/PIIIX-org/chapters/commit/5e25516',
      'https://github.com/piiix-org/CHAPTERS/commit/5e25516abcdef',
      'https://github.com/PIIIX-org/chapters/blob/dev/docs/agents/STATE.md',
      'https://github.com/PIIIX-org/chapters/tree/dev/server/test',
      // Review records at a commit, and Actions artifacts (UI and API URLs).
      'https://github.com/PIIIX-org/chapters/blob/c5d1d1b7b2ed4e92a6da5d5a12cdc709da5097ab/docs/reviews/1011-a6fe0b6.md',
      'https://raw.githubusercontent.com/PIIIX-org/chapters/c5d1d1b7b2ed4e92a6da5d5a12cdc709da5097ab/docs/reviews/1011-a6fe0b6.md',
      'https://github.com/PIIIX-org/chapters/actions/runs/41189703249/artifacts/4812233991',
      'https://github.com/PIIIX-org/chapters/actions/artifacts/4812233991',
      'https://api.github.com/repos/PIIIX-org/chapters/actions/artifacts/4812233991/zip',
      'https://api.github.com/repos/PIIIX-org/chapters/actions/runs/41189703249',
    ]) {
      assert.ok(hasEvidenceUrl(`see [it](${url}).`, REPO), url)
    }
  })
  it('rejects other URLs and bare commit hashes', () => {
    for (const text of [
      'commit 5e25516',
      'https://github.com/PIIIX-org/chapters',
      'https://github.com/PIIIX-org/chapters/actions',
      'https://github.com/PIIIX-org/chapters-fork/pull/1',
      'https://github.com/other/chapters/pull/1',
      'https://github.com/other/chapters/issues/1#issuecomment-2',
      'https://github.com/PIIIX-org/chapters/commit/xyz',
      'https://example.com/PIIIX-org/chapters/pull/1',
      'https://raw.githubusercontent.com/other/chapters/dev/docs/reviews/1.md',
      'https://raw.githubusercontent.com/PIIIX-org/chapters/dev',
      'https://api.github.com/repos/PIIIX-org/chapters/pulls/1',
      'docs/reviews/1011-a6fe0b6.md',
      'other/chapters#12',
      '&#39;',
    ]) {
      assert.ok(!hasEvidenceLink(text, REPO), text)
    }
  })
  it('counts #N and owner/repo#N as links next to a claim, not as URLs', () => {
    assert.ok(hasEvidenceLink('carries #591', REPO))
    assert.ok(hasEvidenceLink('(#591)', REPO))
    assert.ok(hasEvidenceLink('PIIIX-org/chapters#591', REPO))
    assert.ok(!hasEvidenceUrl('carries #591', REPO))
  })
})

describe('mergeGroupPr', () => {
  it('reads the PR number of a merge-queue branch', () => {
    assert.equal(mergeGroupPr('refs/heads/gh-readonly-queue/dev/pr-1050-36b98a7c1e2d3f4a5b6c7d8e9f0a1b2c3d4e5f60'), 1050)
    assert.equal(mergeGroupPr('gh-readonly-queue/dev/pr-7-d49b561'), 7)
    assert.equal(mergeGroupPr('refs/heads/gh-readonly-queue/lab/x/pr-12-0123456789abcdef0123456789abcdef01234567'), 12)
  })
  it('is null for anything else', () => {
    assert.equal(mergeGroupPr('refs/heads/fix/pr-12-abcdef0'), null)
    assert.equal(mergeGroupPr('refs/heads/gh-readonly-queue/dev/pr-12'), null)
    assert.equal(mergeGroupPr(''), null)
    assert.equal(mergeGroupPr(undefined), null)
  })
})

describe('proseUnits', () => {
  it('splits paragraphs into sentences and keeps bullets whole', () => {
    assert.deepEqual(
      texts(
        [
          'First sentence here. Second one',
          'wraps a line! Third?',
          '',
          '- a bullet. With two sentences',
          '  and a continuation',
          '* another',
          '1. numbered',
          '',
          '| a | b |',
          '## Heading with stable in it',
          '> quoted text',
        ].join('\n'),
      ),
      [
        'First sentence here.',
        'Second one wraps a line!',
        'Third?',
        '- a bullet. With two sentences and a continuation',
        '* another',
        '1. numbered',
        '| a | b |',
        'quoted text',
      ],
    )
  })
  it('skips headings and table header rows', () => {
    assert.deepEqual(
      texts('### Verified email badge\n\n| Stable? | Run |\n| --- | --- |\n| yes | x |'),
      ['| yes | x |'],
    )
  })
  it('judges a list item with its parents and nested items, not its siblings', () => {
    const units = proseUnits(
      '- All tests pass:\n  - run one\n    - deep\n- sibling\n\nafter',
    )
    assert.deepEqual(
      units.map((u) => [u.text, u.context]),
      [
        ['- All tests pass:', '- All tests pass: - run one - deep'],
        ['- run one', '- All tests pass: - run one - deep'],
        ['- deep', '- All tests pass: - run one - deep'],
        ['- sibling', '- sibling'],
        ['after', 'after'],
      ],
    )
  })
})

describe('unlinkedClaims', () => {
  it('flags a claim with no link in its sentence, bullet or row', () => {
    assert.deepEqual(unlinkedClaims('All tests pass.', REPO), [
      { claims: ['all tests pass'], text: 'All tests pass.' },
    ])
    assert.equal(
      unlinkedClaims(`- All tests pass: ${RUN}\n- 100% green`, REPO).length,
      1,
    )
  })
  it('flags counts, ratios and zero-error claims', () => {
    const body =
      'All 49 tests pass. 476/476 tests passing, 0 errors, no regressions, tested end-to-end, fully covered. The tests all pass. CI is green.'
    assert.equal(unlinkedClaims(body, REPO).length, 4)
  })
  it('accepts the same claim with a link in the same unit', () => {
    assert.deepEqual(unlinkedClaims(`All tests pass (${RUN}).`, REPO), [])
    assert.deepEqual(
      unlinkedClaims(`| lint | all tests pass | [run](${RUN}) |`, REPO),
      [],
    )
    assert.deepEqual(unlinkedClaims(`- All tests pass:\n  - ${RUN}`, REPO), [])
    assert.deepEqual(
      unlinkedClaims(`All tests pass ([run][1]).\n\n[1]: ${RUN}`, REPO),
      [],
    )
    assert.deepEqual(unlinkedClaims('- #591 feat: verified email badge', REPO), [])
  })
  it('does not borrow a link from the next sentence or a sibling bullet', () => {
    assert.equal(
      unlinkedClaims(`The build is stable. CI: ${RUN}`, REPO).length,
      1,
    )
    assert.equal(
      unlinkedClaims(`- CI: ${RUN}\n- All tests pass`, REPO).length,
      1,
    )
  })
  it('does not flag words in headings', () => {
    assert.deepEqual(unlinkedClaims('## Stable sort for search results', REPO), [])
  })
})

describe('check', () => {
  it('passes a normal body', () => {
    assert.equal(check(pr(goodBody), REPO).ok, true)
  })
  it('fails a body without an Evidence section', () => {
    const r = check(pr('## Problem\n\nx\n\n## Change\n\ny'), REPO)
    assert.equal(r.ok, false)
    assert.equal(r.evidence, 'missing')
    assert.equal(check(pr(null), REPO).ok, false)
  })
  it('fails the unfilled template file', () => {
    const template = readFileSync(
      new URL('../pull_request_template.md', import.meta.url),
      'utf8',
    )
    const r = check(pr(template), REPO)
    assert.equal(r.ok, false)
    assert.equal(r.evidence, 'missing')
    assert.deepEqual(r.claims, [])
  })
  it('fails a placeholder Evidence section', () => {
    for (const s of ['TBD', 'n/a', 'Tested locally.', '-']) {
      const r = check(pr(`## Evidence\n\n${s}`), REPO)
      assert.equal(r.ok, false, s)
      assert.equal(r.evidence, 'no-link', s)
      assert.match(r.report, /links nothing/)
    }
    const r = check(pr('## Evidence\n\nCI: <run link>'), REPO)
    assert.equal(r.evidence, 'placeholder')
    assert.match(r.report, /`<run link>`/)
  })
  it('fails an unlinked claim anywhere in the body', () => {
    const r = check(pr(`${goodBody}\n\nAll tests pass.`), REPO)
    assert.equal(r.ok, false)
    assert.equal(r.evidence, 'ok')
    assert.deepEqual(r.claims, [
      { claims: ['all tests pass'], text: 'All tests pass.' },
    ])
  })
  it('passes the same claim with a run URL', () => {
    assert.equal(
      check(pr(`${goodBody}\n\nAll tests pass: ${RUN}`), REPO).ok,
      true,
    )
  })
  it('covers promotion PRs, where carried PRs may be listed as #N', () => {
    const promo = { title: 'Promote: study fixes', base: { ref: 'prod' } }
    const bad = check(pr('Promote everything. 100% green, verified.', promo), REPO)
    assert.equal(bad.ok, false)
    assert.equal(bad.evidence, 'missing')
    assert.deepEqual(bad.claims[0].claims, ['100%', 'verified'])
    const good = check(
      pr(
        withEvidence('- #591 check-notes: every note file parses\n- #592 verified secret scan'),
        promo,
      ),
      REPO,
    )
    assert.equal(good.ok, true)
  })
  it('passes a Revert-button PR without an Evidence section', () => {
    const r = check(
      pr('Reverts PIIIX-org/chapters#590', { title: 'Revert "ci: publish"' }),
      REPO,
    )
    assert.equal(r.ok, true)
    assert.equal(r.evidence, 'revert')
  })
  it('skips Dependabot', () => {
    const r = check(
      pr('Bumps x from 1.0 to 1.1 (stable release).', {
        user: { login: 'dependabot[bot]', type: 'Bot' },
      }),
      REPO,
    )
    assert.equal(r.ok, true)
    assert.equal(r.skipped, true)
  })
  it('reports to markdown with each offending unit', () => {
    const r = check(pr('Verified | by hand. Stable.'), REPO)
    assert.match(r.report, /no `## Evidence` section/)
    assert.match(r.report, /\| `verified` \| Verified \\\| by hand\. \|/)
    assert.match(r.report, /\| `stable` \| Stable\. \|/)
  })
})
