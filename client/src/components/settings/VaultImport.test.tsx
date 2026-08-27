import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { ImportResult } from '../../api/import.js'
import { VaultImport } from './VaultImport.js'

// Every field distinct, and unmatchedShares deliberately NON-empty: an empty
// list cannot tell a working list from one that was never rendered, and the
// counts must differ from each other so a swapped imported/skipped still fails.
const RESULT: ImportResult = {
  vaultId: 'v-imported-9',
  imported: 23,
  // A list of reasons, exactly as the server sends it — not a count. The
  // original fixture used a number, which is why a broken sentence and four
  // discarded explanations passed review.
  skipped: [
    'notes/draft.md: frontmatter is missing required key "type"',
    'notes/broken.md: could not parse frontmatter',
  ],
  unmatchedShares: ['ada@example.com', 'grace@example.org', 'katherine@example.net'],
}

const ARCHIVE = new File(['PK'], 'field-notes.zip', { type: 'application/zip' })

const IMPORT_BUTTON = { name: 'Import as a new vault' }

function stubImport(respond: () => Response) {
  const fetchMock = vi.fn((url: string) => {
    if (url !== '/api/import') throw new Error(`unstubbed request: ${url}`)
    return Promise.resolve(respond())
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// MemoryRouter: the success state links to the new vault with <Link>, which
// throws outside a router.
function renderImport() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <VaultImport />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Picks the archive and runs the import, leaving the result on screen. */
async function runImport() {
  await userEvent.upload(screen.getByLabelText('Vault archive (.zip)'), ARCHIVE)
  await userEvent.click(screen.getByRole('button', IMPORT_BUTTON))
}

describe('VaultImport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says a NEW vault is created, before anything is uploaded', async () => {
    const { container } = renderImport()
    const copy = container.textContent!

    // The person this surprises expects a merge into a vault they already have,
    // and by the time the result screen loads it is too late to tell them.
    expect(copy).toMatch(/always creates a new vault that you own/i)
    expect(copy).toMatch(/never merges/i)
    expect(copy).toMatch(/only where their email already has an account on this instance/i)

    expect(screen.getByLabelText('Vault archive (.zip)')).toHaveAttribute('accept', '.zip,application/zip')
    // Nothing to import yet, so nothing to press.
    expect(screen.getByRole('button', IMPORT_BUTTON)).toBeDisabled()

    await expectNoA11yViolations(container)
  })

  it('reports imported and skipped counts and names every unmatched share', async () => {
    stubImport(() => mockJsonResponse(200, RESULT))
    const { container } = renderImport()

    await runImport()

    const summary = await screen.findByRole('status')
    expect(summary).toHaveTextContent('23 notes imported')
    expect(summary).toHaveTextContent('2 notes skipped')
    // The reasons themselves, not just how many: they are the only place
    // anything says which notes failed or why.
    expect(summary).toHaveTextContent('notes/draft.md')
    expect(summary).toHaveTextContent('could not parse frontmatter')
    // "23 notes imported" while three people lost access is not a success
    // message: each of them is named, not counted and hidden.
    expect(summary).toHaveTextContent(/3 people listed in the archive got no access/i)
    for (const email of RESULT.unmatchedShares) {
      expect(within(summary).getByText(email)).toBeInTheDocument()
    }

    await expectNoA11yViolations(container)
  })

  it('links to the vault it just created', async () => {
    stubImport(() => mockJsonResponse(200, RESULT))
    renderImport()

    await runImport()

    expect(await screen.findByRole('link', { name: 'Open the new vault' })).toHaveAttribute(
      'href',
      '/vaults/v-imported-9',
    )
  })

  it('surfaces the server message inline when the archive is rejected', async () => {
    stubImport(() => mockJsonResponse(400, { error: 'not a valid zip archive' }))
    const { container } = renderImport()

    await runImport()

    expect(await screen.findByRole('alert')).toHaveTextContent('not a valid zip archive')
    // isError is checked before data, so a failure never renders a summary of
    // zeroes as though the import had worked.
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open the new vault' })).toBeNull()

    await expectNoA11yViolations(container)
  })
})
