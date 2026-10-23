import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { expectNoA11yViolations } from '../../test/axe.js'
import { QuarantineNotice } from './QuarantineNotice.js'

const held = { revisionId: 'abcdef12-3456-7890', repeatedBytes: 3 * 1024, noteBytes: 3 * 1024 + 200, excerpt: 'relay paragraph 4: the 28th observation' }

// #784: the relay quarantined the store and nobody was told; the editor said "Synced".
describe('QuarantineNotice', () => {
  it('says the changes are not saved to the note, where the repeat starts, and how much repeats', () => {
    render(<QuarantineNotice quarantine={held} />)
    const text = screen.getByRole('status').textContent!
    expect(text).toMatch(/not being saved to this note/i)
    expect(text).toContain('relay paragraph 4: the 28th observation')
    expect(text).toContain('3.0 KB')
  })

  it('says nothing is lost: it survives a reload and History keeps it', () => {
    render(<QuarantineNotice quarantine={held} />)
    const text = screen.getByRole('status').textContent!
    expect(text).toMatch(/nothing is lost/i)
    expect(text).toMatch(/after a\s+reload/i)
    expect(text).toMatch(/History keeps it as “Held back \(quarantined\)” \(revision abcdef12\)/)
    expect(text).toMatch(/remove the repeated text/i)
  })

  it('still reads when the relay knows no revision or excerpt', () => {
    render(<QuarantineNotice quarantine={{ revisionId: null, repeatedBytes: 2048, noteBytes: 2100, excerpt: '' }} />)
    const text = screen.getByRole('status').textContent!
    expect(text).not.toMatch(/revision/)
    expect(text).not.toMatch(/starting at/)
  })

  it('is inline, not a dialog, and asks nothing of the user', () => {
    render(<QuarantineNotice quarantine={held} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<QuarantineNotice quarantine={held} />)
    await expectNoA11yViolations(container)
  })
})
