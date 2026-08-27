import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { expectNoA11yViolations } from '../../test/axe.js'
import { CollabStatusLine } from './CollabStatusLine.js'

const AT = new Date('2026-08-25T10:04:00.000Z')

describe('CollabStatusLine', () => {
  it('says "Synced", never "Saved", with the time in font-mono', () => {
    render(<CollabStatusLine status="connected" synced syncedAt={AT} />)

    const line = screen.getByRole('status')
    expect(line).toHaveTextContent(/^Synced/)
    // The relay's disk write is debounced and unacknowledged: this client has
    // no evidence of a save and must not claim one (unit 6 plan, gap 4).
    expect(line.textContent).not.toMatch(/saved/i)

    const time = line.querySelector('time')!
    expect(time.className).toContain('font-mono')
    expect(time.getAttribute('datetime')).toBe(AT.toISOString())
    expect(time.textContent).toBe(AT.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  })

  it('is still syncing while the handshake is done but local edits are unsent', () => {
    render(<CollabStatusLine status="connected" synced={false} syncedAt={AT} />)

    const line = screen.getByRole('status')
    expect(line.textContent).toContain('Syncing')
    // A stale "Synced 10:04" next to unsent text is the lie this guards.
    expect(line.textContent).not.toContain('Synced')
    expect(line.querySelector('time')).toBeNull()
  })

  it('says something different for offline than for revoked', () => {
    const { unmount } = render(<CollabStatusLine status="offline" synced={false} syncedAt={null} />)
    const offline = screen.getByRole('status').textContent!
    unmount()

    render(<CollabStatusLine status="revoked" synced={false} syncedAt={null} />)
    const revoked = screen.getByRole('status').textContent!

    expect(offline).not.toBe(revoked)
    // Offline: nothing was taken away, the text is just sitting here.
    expect(offline).toMatch(/staying in this tab/i)
    expect(offline).not.toMatch(/access/i)
    // Revoked: access is gone, and coming back will not help.
    expect(revoked).toMatch(/access removed/i)
    expect(revoked).not.toMatch(/staying in this tab/i)
  })

  it('distinguishes the first connect from a mid-session drop', () => {
    const { unmount } = render(<CollabStatusLine status="connecting" synced={false} syncedAt={null} />)
    expect(screen.getByRole('status').textContent).toMatch(/^Connecting/)
    unmount()

    render(<CollabStatusLine status="reconnecting" synced={false} syncedAt={AT} />)
    expect(screen.getByRole('status').textContent).toMatch(/^Reconnecting/)
  })

  it('whispers in muted text, not in an accent colour', () => {
    render(<CollabStatusLine status="connecting" synced={false} syncedAt={null} />)
    const line = screen.getByRole('status')
    expect(line.className).toContain('text-muted-foreground')
    // `accent` is the teal AI token; a sync status is not an AI signal.
    expect(line.className).not.toContain('accent')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<CollabStatusLine status="connected" synced syncedAt={AT} />)
    await expectNoA11yViolations(container)
  })
})
