import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { expectNoA11yViolations } from '../../test/axe.js'
import { TooLargeNotice } from './TooLargeNotice.js'

const MiB = 1024 * 1024

describe('TooLargeNotice', () => {
  it('says the change was not saved, that the text is still here, the limit and how much to cut', () => {
    render(<TooLargeNotice limitBytes={MiB} bodyBytes={MiB + 300 * 1024} />)
    const text = screen.getByRole('status').textContent!

    expect(text).toMatch(/too large to save/i)
    expect(text).toMatch(/not saved/i)
    expect(text).toMatch(/still here and kept in this browser/i)
    expect(text).toContain('1.00 MB')
    expect(text).toContain('1.29 MB')
    expect(text).toContain('remove about 300.0 KB')
    expect(text).toMatch(/sync again/i)
    expect(text).toMatch(/undo history for this note is cleared/i)
  })

  it('still says what to do when this tab measures the note under the limit', () => {
    render(<TooLargeNotice limitBytes={MiB} bodyBytes={MiB - 10} />)
    expect(screen.getByRole('status').textContent).toMatch(/remove some text/i)
  })

  it('is inline, not a dialog, and asks nothing of the user', () => {
    render(<TooLargeNotice limitBytes={MiB} bodyBytes={2 * MiB} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<TooLargeNotice limitBytes={MiB} bodyBytes={2 * MiB} />)
    await expectNoA11yViolations(container)
  })
})
