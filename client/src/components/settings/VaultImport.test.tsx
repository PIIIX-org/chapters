import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { ImportResult } from '../../api/import.js'
import { VaultImport } from './VaultImport.js'

// Every field distinct, and both share lists deliberately NON-empty: an empty
// list cannot tell a working list from one that was never rendered, and the
// counts must differ from each other so a swapped imported/skipped still fails.
const RESULT: ImportResult = {
  vaultId: 'v-imported-9',
  imported: 23,
  trashed: 4,
  // A list of reasons, exactly as the server sends it — not a count. The
  // original fixture used a number, which is why a broken sentence and four
  // discarded explanations passed review.
  skipped: [
    'notes/draft.md: frontmatter is missing required key "type"',
    'notes/broken.md: could not parse frontmatter',
  ],
  appliedShares: [{ granteeType: 'user', grantee: 'ada@example.com', permission: 'edit' }],
  skippedShares: [
    { granteeType: 'user', grantee: 'grace@example.org', permission: 'read', reason: 'no_active_user' },
    { granteeType: 'team', grantee: 'Analysts', permission: 'read', reason: 'no_team' },
    { granteeType: 'user', grantee: 'katherine@example.net', permission: 'edit', reason: 'duplicate' },
  ],
}

const ARCHIVE = new File(['PK'], 'field-notes.zip', { type: 'application/zip' })

const IMPORT_BUTTON = { name: 'Import as a new vault' }
const SHARE_BOX = { name: /give the archive's collaborators access again/i }

function stubImport(respond: () => Response) {
  const fetchMock = vi.fn((url: string) => {
    if (!url.startsWith('/api/import')) throw new Error(`unstubbed request: ${url}`)
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
async function runImport({ applyShares = false } = {}) {
  await userEvent.upload(screen.getByLabelText('Vault archive (.zip)'), ARCHIVE)
  if (applyShares) await userEvent.click(screen.getByRole('checkbox', SHARE_BOX))
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
    expect(copy).toMatch(/they get access only if you tick the box below/i)
    // Sharing from the archive is opt-in: the box starts unticked (#621).
    expect(screen.getByRole('checkbox', SHARE_BOX)).not.toBeChecked()

    expect(screen.getByLabelText('Vault archive (.zip)')).toHaveAttribute('accept', '.zip,application/zip')
    // Nothing to import yet, so nothing to press.
    expect(screen.getByRole('button', IMPORT_BUTTON)).toBeDisabled()

    await expectNoA11yViolations(container)
  })

  it('asks the server to apply shares only when the box is ticked', async () => {
    const fetchMock = stubImport(() => mockJsonResponse(200, RESULT))
    renderImport()

    await runImport()
    await screen.findByRole('status')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/import', expect.anything())

    await runImport({ applyShares: true })
    await screen.findByRole('status')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/import?applyShares=true', expect.anything())
  })

  it('reports imported and skipped counts and names every applied and skipped share', async () => {
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
    // Who got access is stated, never implied.
    expect(summary).toHaveTextContent(/1 collaborator from the archive got access to the new vault/i)
    expect(within(summary).getByText(/ada@example\.com \(edit\)/)).toBeInTheDocument()
    // "23 notes imported" while three collaborators got nothing is not a
    // success message: each of them is named, with the reason.
    expect(summary).toHaveTextContent(/3 collaborators listed in the archive got no access/i)
    expect(within(summary).getByText(/grace@example\.org \(read\).*no active account/)).toBeInTheDocument()
    expect(within(summary).getByText(/team Analysts \(read\).*no team with this name/)).toBeInTheDocument()
    expect(within(summary).getByText(/katherine@example\.net \(edit\).*listed more than once/)).toBeInTheDocument()

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
