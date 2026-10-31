// Unit tests for migration-order-check.mjs.
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  check,
  entries,
  newest,
  sqlPath,
  summaryMarkdown,
} from './migration-order-check.mjs'

const entry = (
  idx,
  when,
  tag = `${String(idx).padStart(4, '0')}_tag${idx}`,
) => ({
  idx,
  version: '7',
  when,
  tag,
  breakpoints: true,
})
const journal = (...list) => ({
  version: '7',
  dialect: 'postgresql',
  entries: list,
})

const DEV = journal(entry(0, 1000), entry(1, 2000), entry(2, 3000))
const allFiles = () => true
const messages = (r) => r.problems.map((p) => p.message)

describe('entries / newest', () => {
  it('tolerate a missing journal', () => {
    assert.deepEqual(entries(null), [])
    assert.deepEqual(entries({}), [])
    assert.deepEqual(newest(null), { when: null, idx: null })
  })
  it('find the largest when and idx', () => {
    assert.deepEqual(newest(DEV), { when: 3000, idx: 2 })
    assert.deepEqual(newest(journal(entry(5, 9), entry(1, 20))), {
      when: 20,
      idx: 5,
    })
  })
})

describe('check: added entries', () => {
  it('passes a migration newer than everything on dev', () => {
    const head = journal(...DEV.entries, entry(3, 4000))
    const r = check({ base: DEV, head, dev: DEV, fileExists: allFiles })
    assert.equal(r.ok, true, messages(r).join('\n'))
    assert.equal(r.added.length, 1)
    assert.equal(r.added[0].tag, '0003_tag3')
  })

  it('passes when the PR adds no entry', () => {
    const r = check({ base: DEV, head: DEV, dev: DEV, fileExists: allFiles })
    assert.equal(r.ok, true)
    assert.deepEqual(r.added, [])
  })

  it('compares against dev, not the stale base', () => {
    // Branched from idx 1; dev gained idx 2 (when 3000) meanwhile.
    const base = journal(entry(0, 1000), entry(1, 2000))
    const head = journal(
      entry(0, 1000),
      entry(1, 2000),
      entry(2, 2500, '0002_mine'),
    )
    const r = check({ base, head, dev: DEV, fileExists: allFiles })
    assert.equal(r.ok, false)
    const msgs = messages(r)
    assert.ok(
      msgs.some((m) =>
        m.includes('when 2500, not greater than the newest when on dev (3000)'),
      ),
      msgs,
    )
    assert.ok(
      msgs.some((m) =>
        m.includes('idx 2, not greater than the largest idx on dev (2)'),
      ),
      msgs,
    )
  })

  it('rejects an equal when (strictly greater required)', () => {
    const head = journal(...DEV.entries, entry(3, 3000))
    const r = check({ base: DEV, head, dev: DEV, fileExists: allFiles })
    assert.equal(r.ok, false)
    assert.ok(messages(r).some((m) => m.includes('when 3000, not greater')))
  })

  it('rejects a tag that already exists on dev', () => {
    const base = journal(entry(0, 1000), entry(1, 2000))
    const head = journal(
      entry(0, 1000),
      entry(1, 2000),
      entry(3, 4000, '0003_x'),
    )
    const dev = journal(...DEV.entries, entry(3, 3500, '0003_x'))
    const r = check({ base, head, dev, fileExists: allFiles })
    assert.ok(
      messages(r).some((m) => m.includes('`0003_x` already exists on dev')),
    )
  })

  it('requires the SQL file at the head', () => {
    const head = journal(...DEV.entries, entry(3, 4000))
    const r = check({
      base: DEV,
      head,
      dev: DEV,
      fileExists: (p) => p !== sqlPath('0003_tag3'),
    })
    assert.equal(r.ok, false)
    assert.ok(
      messages(r).some((m) =>
        m.includes('has no `server/drizzle/0003_tag3.sql`'),
      ),
    )
  })

  it('requires idx, tag and when', () => {
    const head = journal(...DEV.entries, { version: '7', breakpoints: true })
    const r = check({ base: DEV, head, dev: DEV, fileExists: allFiles })
    assert.equal(r.ok, false)
    const [m] = messages(r)
    assert.match(
      m,
      /lacks `idx` \(integer\), `tag` \(string\), `when` \(integer/,
    )
  })

  it('requires the tag to carry the zero-padded idx', () => {
    const head = journal(...DEV.entries, entry(3, 4000, '0004_wrong'))
    const r = check({ base: DEV, head, dev: DEV, fileExists: allFiles })
    assert.ok(
      messages(r).some((m) =>
        m.includes('idx 3 but its tag does not start with `0003_`'),
      ),
    )
  })

  it('passes a first migration when dev has no journal', () => {
    const head = journal(entry(0, 1000))
    const r = check({ base: null, head, dev: null, fileExists: allFiles })
    assert.equal(r.ok, true, messages(r).join('\n'))
  })
})

describe('check: existing entries and order', () => {
  it('rejects a removed base entry', () => {
    const head = journal(entry(0, 1000), entry(2, 3000))
    const r = check({ base: DEV, head, dev: DEV, fileExists: allFiles })
    assert.ok(
      messages(r).some((m) =>
        m.includes('`0001_tag1` is in the base journal but not in the head'),
      ),
    )
  })

  it('rejects an edited when on a base entry (the bypass)', () => {
    const head = journal(entry(0, 1000), entry(1, 2000), entry(2, 5000))
    const r = check({ base: DEV, head, dev: DEV, fileExists: allFiles })
    assert.ok(
      messages(r).some((m) =>
        m.includes('`0002_tag2` differs from the base journal'),
      ),
    )
  })

  it('rejects an out-of-order head journal', () => {
    const head = journal(...DEV.entries, entry(4, 5000), entry(3, 4000))
    const r = check({ base: DEV, head, dev: DEV, fileExists: allFiles })
    const msgs = messages(r)
    assert.ok(
      msgs.some((m) => m.includes('idx must strictly increase')),
      msgs,
    )
    assert.ok(
      msgs.some((m) => m.includes('when must strictly increase')),
      msgs,
    )
  })

  it('rejects a head without a journal when the base had one', () => {
    const r = check({ base: DEV, head: null, dev: DEV, fileExists: allFiles })
    assert.equal(r.ok, false)
    assert.match(messages(r)[0], /missing at the head/)
  })

  it('does not judge the order of entries the base already has', () => {
    // dev's journal has an old inversion (0026 when > 0027 when); a PR that
    // adds a later entry is not blamed for it.
    const dev = journal(entry(0, 1000), entry(1, 3000), entry(2, 2000))
    const head = journal(...dev.entries, entry(3, 4000))
    const r = check({ base: dev, head, dev, fileExists: allFiles })
    assert.equal(r.ok, true, messages(r).join('\n'))
  })

  it('accepts entries queued ahead of this PR that are not on dev yet', () => {
    // Merge queue: base (previous queue entry) already carries idx 3; this
    // PR adds idx 4. Dev still ends at idx 2.
    const base = journal(...DEV.entries, entry(3, 4000))
    const head = journal(...base.entries, entry(4, 5000))
    const r = check({ base, head, dev: DEV, fileExists: allFiles })
    assert.equal(r.ok, true, messages(r).join('\n'))
    assert.equal(r.added.length, 1)
  })
})

describe('summaryMarkdown', () => {
  it('lists added entries with a verdict mark and the problems', () => {
    const head = journal(...DEV.entries, entry(3, 2500))
    const r = check({ base: DEV, head, dev: DEV, fileExists: allFiles })
    const md = summaryMarkdown(
      r,
      { base: 'b', head: 'h', dev: 'd' },
      newest(DEV),
    )
    assert.match(md, /^## Migration order check: failed/)
    assert.match(md, /newest when on dev: 3000, largest idx: 2/)
    assert.match(md, /\| `0003_tag3` \| 3 \| 2500 \| ❌ \|/)
    assert.match(md, /\*\*Problems\*\*\n\n- `0003_tag3` has when 2500/)
  })
  it('says when nothing was added', () => {
    const r = check({ base: DEV, head: DEV, dev: DEV, fileExists: allFiles })
    const md = summaryMarkdown(
      r,
      { base: 'b', head: 'h', dev: 'd' },
      newest(DEV),
    )
    assert.match(md, /passed/)
    assert.match(md, /adds no journal entry/)
  })
})
