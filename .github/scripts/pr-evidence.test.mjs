// Unit tests for the pure parts of pr-evidence.mjs (#579).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  check,
  claimsIn,
  evidenceSection,
  hasEvidenceLink,
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
  it('accepts any heading level, case and a suffix', () => {
    assert.ok(evidenceSection('# EVIDENCE\nsee run'))
    assert.ok(evidenceSection('### Evidence (CI and lab)\nsee run'))
  })
  it('accepts a bold label line, with content on the same line', () => {
    assert.equal(evidenceSection('**Evidence:** see the run'), 'see the run')
    assert.match(
      evidenceSection('**Evidence**\n- run one\n\n**Not covered**\n- x'),
      /run one/,
    )
    assert.doesNotMatch(
      evidenceSection('**Evidence**\n- run one\n\n**Not covered**\n- x'),
      /- x/,
    )
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

describe('claimsIn', () => {
  it('finds each claim word, case-insensitive', () => {
    const cases = {
      '100% remediated': ['100%', 'remediated'],
      'Coverage is 100 %.': ['100%'],
      'Verified on staging.': ['verified'],
      'The feature is fully tested.': ['fully tested'],
      'Fully-tested code.': ['fully tested'],
      'All tests pass.': ['all tests pass'],
      'all the tests passed': ['all tests pass'],
      'ALL TESTS PASSING': ['all tests pass'],
      'This is production-ready.': ['production-ready'],
      'production ready': ['production-ready'],
      'The API is stable now.': ['stable'],
      'Zero bugs left.': ['zero bugs'],
    }
    for (const [text, want] of Object.entries(cases)) {
      assert.deepEqual(claimsIn(text), want, text)
    }
  })
  it('matches whole words only', () => {
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

describe('hasEvidenceLink', () => {
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
    ]) {
      assert.ok(hasEvidenceLink(`see [it](${url}).`, REPO), url)
    }
  })
  it('rejects other URLs and bare references', () => {
    for (const text of [
      'see #579',
      'commit 5e25516',
      'https://github.com/PIIIX-org/chapters',
      'https://github.com/PIIIX-org/chapters/actions',
      'https://github.com/PIIIX-org/chapters-fork/pull/1',
      'https://github.com/other/chapters/pull/1',
      'https://github.com/PIIIX-org/chapters/commit/xyz',
      'https://example.com/PIIIX-org/chapters/pull/1',
      'https://chapters.piiix.org/',
    ]) {
      assert.ok(!hasEvidenceLink(text, REPO), text)
    }
  })
})

describe('proseUnits', () => {
  it('splits paragraphs into sentences and keeps bullets whole', () => {
    const units = proseUnits(
      [
        'First sentence here. Second one',
        'wraps a line! Third?',
        '',
        '- a bullet. With two sentences',
        '  and a continuation',
        '* another',
        '1. numbered',
        '| a | b |',
        '## Heading',
        '> quoted text',
      ].join('\n'),
    )
    assert.deepEqual(units, [
      'First sentence here.',
      'Second one wraps a line!',
      'Third?',
      '- a bullet. With two sentences and a continuation',
      '* another',
      '1. numbered',
      '| a | b |',
      '## Heading',
      'quoted text',
    ])
  })
  it('drops comments and fenced code', () => {
    assert.deepEqual(
      proseUnits('a <!-- stable --> b\n```\nall tests pass\n```\n~~~\nx\n~~~'),
      ['a  b'],
    )
  })
})

describe('unlinkedClaims', () => {
  it('flags a claim with no link in its sentence or bullet', () => {
    assert.deepEqual(unlinkedClaims('All tests pass.', REPO), [
      { claims: ['all tests pass'], text: 'All tests pass.' },
    ])
    assert.equal(
      unlinkedClaims(`- All tests pass: ${RUN}\n- 100% green`, REPO).length,
      1,
    )
  })
  it('accepts the same claim with a run link in the same unit', () => {
    assert.deepEqual(unlinkedClaims(`All tests pass (${RUN}).`, REPO), [])
    assert.deepEqual(
      unlinkedClaims(`| lint | all tests pass | [run](${RUN}) |`, REPO),
      [],
    )
  })
  it('does not borrow a link from the next sentence', () => {
    assert.equal(
      unlinkedClaims(`The build is stable. CI: ${RUN}`, REPO).length,
      1,
    )
  })
})

describe('check', () => {
  it('passes a normal body', () => {
    assert.equal(check(pr(goodBody), REPO).ok, true)
  })
  it('fails a body without an Evidence section', () => {
    const r = check(pr('## Problem\n\nx\n\n## Change\n\ny'), REPO)
    assert.equal(r.ok, false)
    assert.equal(r.missingEvidence, true)
    assert.equal(check(pr(null), REPO).ok, false)
  })
  it('fails the unfilled template', () => {
    const template = [
      '## Problem',
      '',
      '<!-- what is wrong -->',
      '',
      '## Evidence',
      '',
      '<!-- CI run; fails-before run; lab run; benchmark delta.',
      'Never write 100% or verified without a link. -->',
      '',
      '## Not covered',
      '',
      'Closes #',
    ].join('\n')
    const r = check(pr(template), REPO)
    assert.equal(r.ok, false)
    assert.equal(r.missingEvidence, true)
    assert.deepEqual(r.claims, [])
  })
  it('fails an unlinked claim anywhere in the body', () => {
    const r = check(pr(`${goodBody}\n\nAll tests pass.`), REPO)
    assert.equal(r.ok, false)
    assert.equal(r.missingEvidence, false)
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
  it('covers promotion PRs', () => {
    const r = check(
      pr('Promote everything. 100% green, verified.', {
        title: 'Promote: study fixes',
        base: { ref: 'prod' },
      }),
      REPO,
    )
    assert.equal(r.ok, false)
    assert.equal(r.missingEvidence, true)
    assert.deepEqual(r.claims[0].claims, ['100%', 'verified'])
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
