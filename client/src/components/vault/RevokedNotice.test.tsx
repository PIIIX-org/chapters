import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { expectNoA11yViolations } from '../../test/axe.js'
import { RevokedNotice } from './RevokedNotice.js'

describe('RevokedNotice', () => {
  it('says what happened, that unsent text is still here, and what to do about it', () => {
    render(<RevokedNotice />)
    const text = screen.getByRole('status').textContent!

    expect(text).toMatch(/access to this note was removed/i)
    // The whole reason the Y.Doc is not destroyed on a kick: the unsent text is
    // the one thing that must survive, and the person has to be told it is
    // theirs to rescue.
    expect(text).toMatch(/still on screen/i)
    expect(text).toMatch(/copy it somewhere safe/i)
    expect(text).toMatch(/ask the vault owner/i)
  })

  it('is inline, not a dialog, and asks nothing of the user', () => {
    const { container } = render(<RevokedNotice />)

    // A modal over the document would hide the unsent text it is telling the
    // person to copy out.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    // `accent` is the AI/MCP teal token; a revocation is not an AI signal.
    expect(container.innerHTML).not.toContain('accent')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<RevokedNotice />)
    await expectNoA11yViolations(container)
  })
})
