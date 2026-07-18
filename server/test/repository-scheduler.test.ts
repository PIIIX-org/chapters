import { describe, expect, it } from 'vitest'
import { shouldPoll } from '../src/repositories/scheduler.js'

const THRESHOLD = 10 * 60 * 1000
const now = new Date('2026-07-18T12:00:00Z')

describe('shouldPoll', () => {
  it('polls when no webhook has ever been seen', () => {
    expect(shouldPoll(null, null, now, THRESHOLD)).toBe(true)
  })

  it('does not poll when a webhook was seen recently', () => {
    const recent = new Date(now.getTime() - 60_000)
    expect(shouldPoll(recent, null, now, THRESHOLD)).toBe(false)
  })

  it('polls when the last webhook is stale and nothing has synced since', () => {
    const stale = new Date(now.getTime() - 20 * 60 * 1000)
    expect(shouldPoll(stale, null, now, THRESHOLD)).toBe(true)
  })

  it('does not poll when a sync already happened more recently than the stale webhook', () => {
    const stale = new Date(now.getTime() - 20 * 60 * 1000)
    const recentSync = new Date(now.getTime() - 60_000)
    expect(shouldPoll(stale, recentSync, now, THRESHOLD)).toBe(false)
  })

  it('polls when the last sync predates the stale webhook', () => {
    const stale = new Date(now.getTime() - 20 * 60 * 1000)
    const oldSync = new Date(now.getTime() - 30 * 60 * 1000)
    expect(shouldPoll(stale, oldSync, now, THRESHOLD)).toBe(true)
  })
})
