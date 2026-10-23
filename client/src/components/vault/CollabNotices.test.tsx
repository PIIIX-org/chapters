import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CollabNotices } from './CollabNotices.js'

const MiB = 1024 * 1024

describe('CollabNotices', () => {
  it('shows a too-large note and an unmerged copy together, so the copy can still be discarded', () => {
    const onDiscard = vi.fn()
    render(
      <CollabNotices
        revoked={false}
        tooLarge={{ limitBytes: MiB, bodyBytes: 2 * MiB, otherBytes: 0, bodyRoomBytes: MiB, otherRoomBytes: MiB }}
        unmerged="text from an earlier session"
        onDiscard={onDiscard}
      />,
    )
    expect(screen.getByText(/too large to save/i)).toBeTruthy()
    expect(screen.getByText(/text from an earlier session/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /discard this copy/i }))
    expect(onDiscard).toHaveBeenCalledOnce()
  })

  it('says the changes are held back when the relay quarantines them (#784), with the other notices', () => {
    render(
      <CollabNotices
        revoked={false}
        tooLarge={null}
        quarantined={{ revisionId: 'abcdef12-3456', repeatedBytes: 3000, noteBytes: 3100, excerpt: 'the repeated start' }}
        unmerged="text from an earlier session"
        onDiscard={() => {}}
      />,
    )
    expect(screen.getByText(/not being saved to this note/i)).toBeTruthy()
    expect(screen.getByText(/text from an earlier session/)).toBeTruthy()
  })

  it('shows only the revocation once access is gone', () => {
    render(
      <CollabNotices
        revoked
        tooLarge={{ limitBytes: MiB, bodyBytes: 2 * MiB, otherBytes: 0, bodyRoomBytes: MiB, otherRoomBytes: MiB }}
        unmerged="text from an earlier session"
        onDiscard={() => {}}
      />,
    )
    expect(screen.queryByText(/too large to save/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /discard this copy/i })).toBeNull()
  })

  it('says a note waiting for the store migration needs an admin restart, not that access was removed', () => {
    render(<CollabNotices revoked={false} notMigrated tooLarge={null} unmerged={null} onDiscard={() => {}} />)
    expect(screen.getByText(/waiting for the store migration/i)).toBeTruthy()
    expect(screen.getByText(/restart the server/i)).toBeTruthy()
    expect(screen.queryByText(/access to this note was removed/i)).toBeNull()
  })

  it('says reload to keep editing when the server names documents differently, not that access was removed', () => {
    render(<CollabNotices revoked={false} reloadRequired tooLarge={null} unmerged={null} onDiscard={() => {}} />)
    expect(screen.getByText(/reload to keep editing/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    expect(screen.queryByText(/access to this note was removed/i)).toBeNull()
  })

  it('says a deleted note is in the trash and can be restored, not that access was removed', () => {
    render(<CollabNotices revoked={false} deleted tooLarge={null} unmerged={null} onDiscard={() => {}} />)
    expect(screen.getByText(/this note was deleted/i)).toBeTruthy()
    expect(screen.getByText(/where it can be restored/i)).toBeTruthy()
    expect(screen.queryByText(/access to this note was removed/i)).toBeNull()
  })

  it('renders nothing when there is nothing to say', () => {
    const { container } = render(<CollabNotices revoked={false} tooLarge={null} unmerged={null} onDiscard={() => {}} />)
    expect(container.textContent).toBe('')
  })
})
