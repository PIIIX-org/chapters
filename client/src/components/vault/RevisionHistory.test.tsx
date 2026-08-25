import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { Revision } from '../../api/revisions.js'
import { RevisionHistory } from './RevisionHistory.js'

// ALL THREE actor types the pg enum defines, at different times. Two of them
// is what let a panel ship that crashed on the third — and 'collab' is the one
// the database emits most, because it is the default actor for every save
// through the realtime relay. Identical timestamps would also hide the per-row
// targeting the revert and purge assertions depend on.
const REVISIONS: Revision[] = [
  {
    id: 'rev-mcp',
    actorType: 'mcp',
    actorId: 'client-1',
    action: 'update',
    createdAt: '2026-08-20T14:30:00.000Z',
  },
  {
    id: 'rev-collab',
    actorType: 'collab',
    actorId: 'u2',
    action: 'update',
    createdAt: '2026-08-19T18:00:00.000Z',
  },
  {
    id: 'rev-user',
    actorType: 'user',
    actorId: 'u1',
    action: 'create',
    createdAt: '2026-08-19T09:15:00.000Z',
  },
]

const REVERT = { name: /^Revert to the version from / }
const PURGE = { name: /^Purge the version from / }

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

/** History GET always answers; anything else must be asserted on explicitly. */
function stubFetch(extra?: (url: string, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handled = extra?.(url, init)
    if (handled) return Promise.resolve(handled)
    return Promise.resolve(mockJsonResponse(200, REVISIONS))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Rows are addressed by who wrote them — the timestamp text is TZ-dependent. */
/**
 * Exact author label, not a substring: 'by a person, co-editing' contains
 * 'by a person', so a substring match silently returns whichever row comes
 * first and the per-row assertions stop meaning anything.
 */
async function row(author: string): Promise<HTMLElement> {
  const items = await screen.findAllByRole('listitem')
  const found = items.find((item) =>
    [...item.querySelectorAll('span')].some((el) => el.textContent?.trim() === author),
  )
  if (!found) throw new Error(`no revision row authored exactly "${author}"`)
  return found
}

function sent(fetchMock: ReturnType<typeof stubFetch>, method: string): boolean {
  return fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === method)
}

describe('RevisionHistory', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says in words which revision a person wrote and which AI wrote', async () => {
    stubFetch()
    const { container } = renderWithClient(
      <RevisionHistory vaultId="v1" path="notes/one.md" access="edit" />,
    )

    const mcpRow = await row('by AI via MCP')
    const userRow = await row('by a person')

    // Text, not class: a screen reader gets the same distinction the colour
    // tokens give a sighted reader.
    expect(mcpRow).not.toBe(userRow)
    expect(mcpRow.textContent).not.toContain('by a person')
    expect(userRow.textContent).not.toContain('by AI via MCP')
    // Each row's controls are individually addressable.
    expect(within(mcpRow).getByRole('button', REVERT).getAttribute('aria-label')).not.toBe(
      within(userRow).getByRole('button', REVERT).getAttribute('aria-label'),
    )

    await expectNoA11yViolations(container)
  })

  it('reverts the clicked revision, and only after the consequence is confirmed', async () => {
    const fetchMock = stubFetch((url, init) =>
      init?.method === 'POST' ? mockJsonResponse(200, { id: 'n1', path: 'notes/one.md' }) : undefined,
    )
    renderWithClient(<RevisionHistory vaultId="v1" path="notes/one.md" access="edit" />)

    const userRow = await row('by a person')
    await userEvent.click(within(userRow).getByRole('button', REVERT))

    expect(within(userRow).getByText(/attributed to you/).textContent).toContain('Nothing is erased')
    // Opening the consequence must not have sent anything.
    expect(sent(fetchMock, 'POST')).toBe(false)

    await userEvent.click(within(userRow).getByRole('button', { name: 'Revert' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/vaults/v1/revert/notes/one.md',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ revisionId: 'rev-user' }) }),
      )
    })
  })

  it('offers purge to the owner and to nobody else', async () => {
    stubFetch()
    const { unmount } = renderWithClient(
      <RevisionHistory vaultId="v1" path="notes/one.md" access="edit" />,
    )
    const editorRow = await row('by AI via MCP')
    expect(within(editorRow).queryByRole('button', PURGE)).toBeNull()
    unmount()

    renderWithClient(<RevisionHistory vaultId="v1" path="notes/one.md" access="owner" />)
    const ownerRow = await row('by AI via MCP')
    expect(within(ownerRow).getByRole('button', PURGE)).toBeTruthy()
  })

  it('warns that a purged revision is gone for good before deleting it', async () => {
    const fetchMock = stubFetch((url, init) =>
      init?.method === 'DELETE' ? mockJsonResponse(200, { status: 'purged' }) : undefined,
    )
    renderWithClient(<RevisionHistory vaultId="v1" path="notes/one.md" access="owner" />)

    const mcpRow = await row('by AI via MCP')
    await userEvent.click(within(mcpRow).getByRole('button', PURGE))

    const warning = within(mcpRow).getByText(/permanently/).textContent
    expect(warning).toContain('cannot be reverted to afterwards')
    expect(sent(fetchMock, 'DELETE')).toBe(false)

    await userEvent.click(within(mcpRow).getByRole('button', { name: 'Purge' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/vaults/v1/revisions/rev-mcp',
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })

  it('explains itself to a read-only viewer instead of requesting a history they cannot have', async () => {
    const fetchMock = stubFetch()
    renderWithClient(<RevisionHistory vaultId="v1" path="notes/one.md" access="read" />)

    expect(screen.getByText(/needs edit access/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('renders a collab-authored revision as a person, not as AI and not as a crash', async () => {
    // 'collab' is the actor for every save through the realtime relay, so it is
    // the commonest value in a real history. The first version of this panel
    // had no entry for it and threw, unmounting the whole panel — on the one
    // screen someone opens to recover lost work.
    stubFetch()
    renderWithClient(<RevisionHistory vaultId="v1" path="notes/one.md" access="owner" />)

    const collabRow = (await screen.findByText(/co-editing/i)).closest('li')!
    // A person, so vermillion — teal is reserved for AI and must never label a
    // human (design system, authorship rule).
    expect(collabRow.querySelector('.text-primary')).not.toBeNull()
    expect(collabRow.querySelector('.text-accent')).toBeNull()
  })
})
