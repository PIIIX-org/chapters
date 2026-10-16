// Unit tests for the pure parts of state-md.mjs (#582).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  END,
  MAX_LIST,
  START,
  phases,
  render,
  replaceBlock,
  shorten,
  sortIssues,
} from './state-md.mjs'

const REPO = 'PIIIX-org/chapters'
const issue = (number, title, labels = [], milestone = null) => ({ number, title, labels, milestone })

const data = () => ({
  repo: REPO,
  promotion: { number: 407, title: 'Promote: study fixes', mergedAt: '2026-10-15T09:00:00Z', sha: '111e3f1abcdef0' },
  ci: { conclusion: 'success', url: 'https://github.com/PIIIX-org/chapters/actions/runs/1' },
  lab: {
    conclusion: 'failure',
    url: 'https://github.com/PIIIX-org/chapters/actions/runs/2',
    jobs: { plan: 'success', lab: 'failure', 'bench-gate': 'success' },
  },
  milestones: [
    { number: 3, title: 'Phase 2: stop data loss', open: 2, closed: 0 },
    { number: 1, title: 'Phase 0: owner actions', open: 1, closed: 0 },
    { number: 2, title: 'Phase 1: guardrails and security', open: 2, closed: 9 },
    { number: 9, title: 'Some other milestone', open: 1, closed: 1 },
  ],
  issues: [
    issue(589, 'Revoke tokens', ['P0', 'owner'], 1),
    issue(582, 'STATE.md generated', ['P1'], 2),
    issue(547, 'Scoped-token tests', ['P0'], 2),
    issue(486, 'One authoritative store', ['P0'], 3),
    issue(408, 'edit_note replaces the whole body', ['bug', 'P0'], 3),
    issue(9, 'cli visualizer', ['deferred']),
  ],
})

describe('render', () => {
  const block = render(data())

  it('is wrapped in the markers', () => {
    assert.ok(block.startsWith(`${START}\n`))
    assert.ok(block.endsWith(`\n${END}`))
  })

  it('reports the promotion, the checks on dev and links only runs that did not pass', () => {
    assert.match(block, /Last promotion to `prod`\*\*: #407 Promote: study fixes \(merged 2026-10-15, `111e3f1`\)/)
    assert.match(block, /CI \(latest push run\) success;/)
    assert.doesNotMatch(block, /actions\/runs\/1\b/)
    assert.match(block, /nightly lab \(full tier\) \*\*failure\*\* \(\[run\]\(https:\/\/github\.com\/PIIIX-org\/chapters\/actions\/runs\/2\)\)/)
    assert.match(block, /bench-gate \(all suites\) success\./)
  })

  it('lists phase progress in phase order and ignores other milestones', () => {
    const line = block.split('\n').find((l) => l.startsWith('- **Phases**'))
    assert.ok(line.indexOf('Phase 0') < line.indexOf('Phase 1') && line.indexOf('Phase 1') < line.indexOf('Phase 2'))
    assert.match(line, /\[Phase 1: guardrails and security\]\(https:\/\/github\.com\/PIIIX-org\/chapters\/milestone\/2\) 9\/11/)
    assert.doesNotMatch(line, /Some other milestone/)
  })

  it('counts open issues by priority and label', () => {
    assert.match(block, /Open issues\*\*: \[6\]\([^)]+\): P0 4, P1 1, P2 0, no priority 1; `bug` 1, `security` 0, `decision` 0, `deferred` 1\./)
  })

  it('lists owner actions, the phase in progress (P0 first, owner excluded) and bugs', () => {
    const lines = block.split('\n')
    const at = (h) => lines.findIndex((l) => l.startsWith(h))
    assert.equal(lines[at('- **Owner actions**') + 1], '  - #589 Revoke tokens (P0)')
    // Phase 0 has only owner actions, so Phase 1 is in progress.
    const p = at('- **In progress: [Phase 1')
    assert.ok(p > 0)
    assert.deepEqual(lines.slice(p + 1, p + 3), ['  - #547 Scoped-token tests (P0)', '  - #582 STATE.md generated (P1)'])
    assert.equal(lines[at('- **Open bugs**') + 1], '  - #408 edit_note replaces the whole body (P0)')
  })

  it('is the same for the same data in any order, with no time or run id of a passing run', () => {
    const shuffled = data()
    shuffled.issues.reverse()
    shuffled.milestones.reverse()
    assert.equal(render(shuffled), block)
    assert.doesNotMatch(block, /\d{2}:\d{2}/)
  })

  it('caps long lists with a count and a link', () => {
    const d = data()
    d.issues = Array.from({ length: MAX_LIST + 3 }, (_, i) => issue(1000 + i, `bug ${i}`, ['bug']))
    const lines = render(d).split('\n')
    const b = lines.findIndex((l) => l.startsWith('- **Open bugs**'))
    assert.equal(lines[b + MAX_LIST + 1], '  - … and 3 more: https://github.com/PIIIX-org/chapters/issues?q=is%3Aopen+label%3Abug')
  })

  it('says so when there is no data', () => {
    const empty = render({ repo: REPO, promotion: null, ci: null, lab: null, milestones: [], issues: [] })
    assert.match(empty, /Last promotion to `prod`\*\*: none found\./)
    assert.match(empty, /CI \(latest push run\) no completed run/)
    assert.match(empty, /Owner actions\*\* \(label `owner`\): none\./)
    assert.match(empty, /In progress\*\*: no phase milestone has open issues\./)
  })
})

describe('helpers', () => {
  it('shorten cuts at a word boundary', () => {
    assert.equal(shorten('a b', 90), 'a b')
    assert.equal(shorten('word '.repeat(30), 20), 'word word word word…')
  })

  it('sortIssues puts P0 first and unprioritised last', () => {
    assert.deepEqual(
      sortIssues([issue(3, 'c'), issue(2, 'b', ['P1']), issue(5, 'e', ['P0']), issue(1, 'a', ['P0'])]).map((i) => i.number),
      [1, 5, 2, 3],
    )
  })

  it('phases sorts by phase number, not title order', () => {
    const ms = [{ number: 1, title: 'Phase 10: x' }, { number: 2, title: 'Phase 2: y' }]
    assert.deepEqual(phases(ms).map((m) => m.number), [2, 1])
  })
})

describe('replaceBlock', () => {
  const doc = `# STATE\n\nIntro.\n\n${START}\nold\n${END}\n\n- **Architecture Traps**: keep me.\n`

  it('replaces only the block and keeps the hand-written text', () => {
    const out = replaceBlock(doc, `${START}\nnew\n${END}`)
    assert.equal(out, `# STATE\n\nIntro.\n\n${START}\nnew\n${END}\n\n- **Architecture Traps**: keep me.\n`)
    assert.equal(replaceBlock(out, `${START}\nnew\n${END}`), out)
  })

  it('refuses a document without one well-formed block', () => {
    assert.throws(() => replaceBlock('# STATE\n', 'x'), /no <!-- state:generated:start -->/)
    assert.throws(() => replaceBlock(`${START}\n`, 'x'), /no <!-- state:generated:end -->/)
    assert.throws(() => replaceBlock(`${END}\n${START}\n`, 'x'), /comes before/)
    assert.throws(() => replaceBlock(`${doc}${doc}`, 'x'), /more than one/)
  })

  it('the repo STATE.md has the markers and the hand-written sections', () => {
    const state = readFileSync(new URL('../../docs/agents/STATE.md', import.meta.url), 'utf8')
    assert.doesNotThrow(() => replaceBlock(state, `${START}\n${END}`))
    assert.match(state, /\*\*Architecture Traps\*\*/)
    assert.match(state, /\*\*Decided against/)
  })
})
