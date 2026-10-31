// Unit tests for review-archive.mjs.
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DAYS, apply, archiveDir, parseRecord, plan, records } from './review-archive.mjs'

const NOW = new Date('2026-10-31T12:00:00Z')
const day = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

describe('parseRecord', () => {
  it('reads the PR number and sha of a record name', () => {
    assert.deepEqual(parseRecord('1046-dd2e1c9.md'), { number: 1046, sha: 'dd2e1c9' })
    assert.deepEqual(parseRecord('967-18430794fde6837324924e4d075aaefd9bd31b09.md'), {
      number: 967,
      sha: '18430794fde6837324924e4d075aaefd9bd31b09',
    })
  })
  it('rejects anything that is not a record', () => {
    for (const name of ['README.md', 'archive', '1046-dd2e1c9.txt', '1046.md', 'x-dd2e1c9.md', '1046-DD2E1C9.md'])
      assert.equal(parseRecord(name), null, name)
  })
})

describe('archiveDir', () => {
  it('is the UTC month of the date', () => {
    assert.equal(archiveDir('2026-10-02T23:30:00Z'), 'archive/2026-10')
    assert.equal(archiveDir('2025-01-31T00:00:00Z'), 'archive/2025-01')
  })
})

describe('plan', () => {
  const names = ['1046-dd2e1c9.md', '972-0238f11.md', '972-c00cbbe.md', '980-0e66010.md', '990-abc1234.md', 'notes.md']
  const pulls = {
    1046: { state: 'closed', merged_at: day(1), closed_at: day(1) },
    972: { state: 'closed', merged_at: day(20), closed_at: day(20) },
    980: { state: 'closed', merged_at: null, closed_at: day(9) },
    990: { state: 'open', merged_at: null, closed_at: null },
  }

  it('moves every record of a PR merged more than DAYS days ago to its merge month', () => {
    assert.deepEqual(plan(names, pulls, NOW), [
      { name: '972-0238f11.md', number: 972, to: archiveDir(day(20)) },
      { name: '972-c00cbbe.md', number: 972, to: archiveDir(day(20)) },
      { name: '980-0e66010.md', number: 980, to: archiveDir(day(9)) },
    ])
  })
  it('keeps records of open, recent and unknown PRs and non-record files', () => {
    const kept = new Set(names)
    for (const m of plan(names, pulls, NOW)) kept.delete(m.name)
    assert.deepEqual([...kept], ['1046-dd2e1c9.md', '990-abc1234.md', 'notes.md'])
    assert.deepEqual(plan(['1-aaaaaaa.md'], {}, NOW), [])
  })
  it('uses the closing date of a PR closed without merging', () => {
    assert.deepEqual(plan(['980-0e66010.md'], pulls, NOW)[0].to, archiveDir(day(9)))
  })
  it('counts from exactly DAYS days: a day short stays, a day over moves', () => {
    const p = (n) => ({ 1: { state: 'closed', merged_at: day(n), closed_at: day(n) } })
    assert.equal(plan(['1-aaaaaaa.md'], p(DAYS - 1), NOW).length, 0)
    assert.equal(plan(['1-aaaaaaa.md'], p(DAYS + 1), NOW).length, 1)
    assert.equal(plan(['1-aaaaaaa.md'], p(DAYS + 1), NOW, 30).length, 0)
  })
})

describe('records and apply', () => {
  it('lists only top-level records and moves them into month directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-archive-'))
    try {
      for (const f of ['972-0238f11.md', '1046-dd2e1c9.md', 'README.md']) writeFileSync(join(dir, f), f)
      mkdirSync(join(dir, 'archive', '2026-09'), { recursive: true })
      writeFileSync(join(dir, 'archive', '2026-09', '900-1234567.md'), 'old')
      assert.deepEqual(records(dir), ['1046-dd2e1c9.md', '972-0238f11.md'])

      apply(dir, [{ name: '972-0238f11.md', number: 972, to: 'archive/2026-10' }])
      assert.deepEqual(readdirSync(dir).sort(), ['1046-dd2e1c9.md', 'README.md', 'archive'])
      assert.deepEqual(readdirSync(join(dir, 'archive', '2026-10')), ['972-0238f11.md'])
      assert.deepEqual(readdirSync(join(dir, 'archive', '2026-09')), ['900-1234567.md'])
      assert.deepEqual(records(dir), ['1046-dd2e1c9.md'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
