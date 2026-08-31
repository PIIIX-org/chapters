import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { VaultLayout } from './VaultLayout'
import type { VaultAccess } from '../../api/vaults'

function stubVaultFetch(access: VaultAccess) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url === '/api/vaults') {
        return Promise.resolve(
          mockJsonResponse(200, [{ id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access }]),
        )
      }
      if (url.endsWith('/trash')) {
        return Promise.resolve(
          mockJsonResponse(200, [
            { id: 't1', path: 'people/old', type: 'people', name: 'old', deletedAt: '2026-08-01T00:00:00.000Z' },
          ]),
        )
      }
      return Promise.resolve(
        mockJsonResponse(200, {
          people: [
            { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' },
          ],
        }),
      )
    }),
  )
}

function renderLayout() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/vaults/:vaultId',
        element: <VaultLayout />,
        children: [{ index: true, element: <div>Empty state</div> }],
      },
    ],
    { initialEntries: ['/vaults/v1'] },
  )
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('VaultLayout', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the file tree in the sidebar and the outlet content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === '/api/vaults') {
          return Promise.resolve(
            mockJsonResponse(200, [{ id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' }]),
          )
        }
        return Promise.resolve(
          mockJsonResponse(200, {
            people: [
              { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' },
            ],
          }),
        )
      }),
    )

    renderLayout()

    await waitFor(() => expect(screen.getByRole('link', { name: 'jane' })).toBeInTheDocument())
    expect(screen.getByText('Empty state')).toBeInTheDocument()
    // The way back is the shell's breadcrumb now; the page's own job is the
    // notes panel, rendered inline here because there is no shell around it.
    expect(screen.getByRole('complementary', { name: 'Engineering' })).toBeInTheDocument()
  })

  it('shows a New note control for an edit-access vault', async () => {
    stubVaultFetch('edit')

    renderLayout()

    await waitFor(() => expect(screen.getByRole('link', { name: 'jane' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /new note/i })).toBeInTheDocument()
  })

  it('hides the New note control for a read-access vault', async () => {
    stubVaultFetch('read')

    renderLayout()

    await waitFor(() => expect(screen.getByRole('link', { name: 'jane' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /new note/i })).toBeNull()
  })

  it('folds the trash behind a pinned toggle for an editor, closed by default', async () => {
    stubVaultFetch('edit')

    const { container } = renderLayout()

    await waitFor(() => expect(screen.getByRole('link', { name: 'jane' })).toBeInTheDocument())
    const toggle = screen.getByRole('button', { name: /trash/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Restore people/old' })).toBeNull()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // heading={false}: the toggle row is the section's title, so the panel
    // must not render a second "Trash" heading under it.
    const restore = await screen.findByRole('button', { name: 'Restore people/old' })
    expect(restore).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /trash/i })).toBeNull()

    await expectNoA11yViolations(container)
  })

  it('gives a reader no trash row — restore needs edit access server-side', async () => {
    stubVaultFetch('read')

    renderLayout()

    await waitFor(() => expect(screen.getByRole('link', { name: 'jane' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /trash/i })).toBeNull()
  })
})
