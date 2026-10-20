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

  it('says signed out, not access removed, when the session ended (#498)', () => {
    render(<CollabStatusLine status="signed-out" synced={false} syncedAt={null} />)
    const line = screen.getByRole('status').textContent!

    expect(line).toMatch(/signed out/i)
    expect(line).toMatch(/log in again/i)
    expect(line).not.toMatch(/access removed/i)
  })

  it('distinguishes the first connect from a mid-session drop', () => {
    const { unmount } = render(<CollabStatusLine status="connecting" synced={false} syncedAt={null} />)
    expect(screen.getByRole('status').textContent).toMatch(/^Connecting/)
    unmount()

    render(<CollabStatusLine status="reconnecting" synced={false} syncedAt={AT} />)
    expect(screen.getByRole('status').textContent).toMatch(/^Offline/)
  })

  it('a dropped socket says "Offline — not saved yet" with the last sync time, never "Syncing…" (#720)', () => {
    render(<CollabStatusLine status="reconnecting" synced={false} syncedAt={AT} />)

    const line = screen.getByRole('status')
    expect(line).toHaveTextContent(/^Offline/)
    expect(line).toHaveTextContent(/not saved yet/)
    expect(line.textContent).not.toMatch(/syncing|reconnecting/i)
    // "Last synced 10:04": what the server holds is the text as of then.
    const time = line.querySelector('time')!
    expect(time.getAttribute('datetime')).toBe(AT.toISOString())
    expect(line).toHaveTextContent(
      `last synced ${AT.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    )
  })

  it('a drop before any sync says offline without inventing a time', () => {
    render(<CollabStatusLine status="reconnecting" synced={false} syncedAt={null} />)
    const line = screen.getByRole('status')
    expect(line).toHaveTextContent(/not saved yet/)
    expect(line.querySelector('time')).toBeNull()
  })

  it('a change refused as too large says it is not saved, not offline (#491)', () => {
    render(<CollabStatusLine status="too-large" synced={false} syncedAt={null} />)
    const line = screen.getByRole('status')
    expect(line).toHaveTextContent(/too large/i)
    expect(line).toHaveTextContent(/not saved/i)
    expect(line).not.toHaveTextContent(/offline/i)
  })

  it('whispers in semantic status tones, never the AI accent', () => {
    render(<CollabStatusLine status="connecting" synced={false} syncedAt={null} />)
    const line = screen.getByRole('status')
    // The pill carries a status tone (idle = warning); `accent` is the teal
    // AI token, and a sync status is not an authorship signal.
    expect(line.querySelector('[class*="warning"]')).not.toBeNull()
    expect(line.innerHTML).not.toContain('accent')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<CollabStatusLine status="connected" synced syncedAt={AT} />)
    await expectNoA11yViolations(container)
  })
})
