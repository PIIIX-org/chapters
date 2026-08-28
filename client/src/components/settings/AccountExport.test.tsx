import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ACCOUNT_EXPORT_URL } from '../../api/account.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import { AccountExport } from './AccountExport.js'

describe('AccountExport', () => {
  it('offers the export as a plain download link, never as a button', async () => {
    const { container } = render(<AccountExport />)

    // A link, not a button: the response is a zip, and apiFetch would try to
    // parse it as JSON. A button would mean someone wired it to a fetch.
    const link = screen.getByRole('link', { name: 'Download my vaults' })
    expect(link).toHaveAttribute('href', ACCOUNT_EXPORT_URL)
    expect(link).toHaveAttribute('download')
    expect(screen.queryByRole('button')).toBeNull()

    await expectNoA11yViolations(container)
  })

  it('says the zip covers vaults you own and excludes ones merely shared with you', () => {
    const { container } = render(<AccountExport />)
    const copy = container.textContent!

    expect(copy).toMatch(/every vault you own/i)
    expect(copy).toMatch(/notes and frontmatter exactly as stored/i)
    expect(copy).toMatch(/manifest/i)
    // The distinction is the whole point: shared-with-you vaults are somebody
    // else's to export, and the page has to say so rather than imply it.
    expect(copy).toMatch(/only shared with you are not included/i)
    expect(copy).toMatch(/plain text/i)
  })
})
