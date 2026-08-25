import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { AccessibleRepository } from '../../api/repositories.js'
import { RepositorySettingsDialog } from './RepositorySettingsDialog.js'

// Two repositories along the axis the delete copy branches on — where the
// code actually lives. A dialog with one hardcoded sentence cannot pass both.
const GIT: AccessibleRepository = {
  id: 'r1',
  name: 'Chapters',
  ownerId: 'me',
  ingestionMethod: 'git',
  gitUrl: 'https://github.com/piiix-org/chapters.git',
  localPath: null,
  defaultBranch: 'dev',
  mergeable: false,
  syncStatus: 'idle',
  lastSyncedAt: '2026-08-24T11:00:00.000Z',
  lastSyncError: null,
  lastWebhookAt: null,
  webhookConfigured: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  access: 'owner',
}

const FOLDER: AccessibleRepository = {
  ...GIT,
  name: 'Notes',
  ingestionMethod: 'local_path',
  gitUrl: null,
  localPath: '/srv/chapters-repos/notes',
  defaultBranch: null,
  mergeable: true,
}

interface Stubs {
  patch?: () => Response
  graphPreference?: () => Response
  putGraphPreference?: () => Response
  del?: () => Response
}

function renderDialog(repository: AccessibleRepository = GIT, stubs: Stubs = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith('/graph-preference')) {
      return init?.method === 'PUT'
        ? Promise.resolve(stubs.putGraphPreference?.() ?? mockJsonResponse(200, { include: true }))
        : Promise.resolve(stubs.graphPreference?.() ?? mockJsonResponse(200, { include: false }))
    }
    if (url.endsWith('/shares')) return Promise.resolve(mockJsonResponse(200, []))
    if (url.endsWith('/sync-tokens')) return Promise.resolve(mockJsonResponse(200, []))
    if (url === '/api/teams') return Promise.resolve(mockJsonResponse(200, []))
    if (init?.method === 'PATCH') {
      return Promise.resolve(stubs.patch?.() ?? mockJsonResponse(200, { ...repository, name: 'Renamed' }))
    }
    if (init?.method === 'DELETE') {
      return Promise.resolve(stubs.del?.() ?? mockJsonResponse(200, { status: 'deleted' }))
    }
    // The mutations invalidate the repository list; answer it quietly.
    if (url === '/api/repositories') return Promise.resolve(mockJsonResponse(200, []))
    throw new Error(`unstubbed request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const onOpenChange = vi.fn()
  const onDeleted = vi.fn()
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RepositorySettingsDialog
        repository={repository}
        open
        onOpenChange={onOpenChange}
        onDeleted={onDeleted}
      />
    </QueryClientProvider>,
  )
  return { ...result, fetchMock, onOpenChange, onDeleted }
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, method: string): unknown {
  const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === method)
  return JSON.parse((call![1] as RequestInit).body as string)
}

describe('RepositorySettingsDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the repository in the dialog and renames it with one PATCH', async () => {
    const { fetchMock } = renderDialog()
    expect(screen.getByRole('dialog', { name: /repository settings — chapters/i })).toBeInTheDocument()

    const nameField = screen.getByLabelText('Name')
    expect(nameField).toHaveValue('Chapters')
    await userEvent.clear(nameField)
    await userEvent.type(nameField, 'Chapters dev')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bodyOf(fetchMock, 'PATCH')).toEqual({ name: 'Chapters dev' }))
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'PATCH')).toHaveLength(1)
  })

  it('toggling mergeable PATCHes it, and rolls back rather than sitting "on" after a failure', async () => {
    const { fetchMock } = renderDialog(GIT, { patch: () => mockJsonResponse(500, { error: 'Internal error' }) })

    const toggle = screen.getByRole('switch', { name: 'Mergeable' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(toggle)

    await waitFor(() => expect(bodyOf(fetchMock, 'PATCH')).toEqual({ mergeable: true }))
    expect(await screen.findByText('Internal error')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(
      screen.getByText("This repository stays out of everyone's merged graph view, including your own."),
    ).toBeInTheDocument()
  })

  it('says the graph preference has no effect while merging is off, and PUTs the new value', async () => {
    const { fetchMock } = renderDialog()

    // GIT is not mergeable, so the per-user switch is honest about that.
    expect(
      await screen.findByText(/Merging is off for this repository, so this has no effect/),
    ).toBeInTheDocument()

    const toggle = screen.getByRole('switch', { name: 'Include in my merged graph' })
    await waitFor(() => expect(toggle).toBeEnabled())
    await userEvent.click(toggle)

    await waitFor(() => expect(bodyOf(fetchMock, 'PUT')).toEqual({ include: true }))
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  })

  it('shows nothing rather than a guessed "off" when the preference cannot be read', async () => {
    renderDialog(FOLDER, { graphPreference: () => mockJsonResponse(500, { error: 'database is down' }) })

    expect(await screen.findByText(/showing nothing rather than guessing/)).toBeInTheDocument()
    // Disabled, because flipping it would write the guess back.
    expect(screen.getByRole('switch', { name: 'Include in my merged graph' })).toBeDisabled()
    // Mergeable is on here, so the "no effect" line must not be what is showing.
    expect(screen.queryByText(/Merging is off for this repository/)).toBeNull()
  })

  it('spells out what deleting a git repository does before it deletes, and calls nothing until confirmed', async () => {
    const { fetchMock, onDeleted, onOpenChange } = renderDialog()
    await screen.findByText('No one else has access to this repository yet.')
    const callsBefore = fetchMock.mock.calls.length

    await userEvent.click(screen.getByRole('button', { name: 'Delete Chapters' }))

    expect(screen.getByText(/removes this connection and everything Chapters indexed from it/)).toBeInTheDocument()
    // The consequence is about the connection, not about the codebase.
    expect(screen.getByText(/the remote and its history stay exactly as they are/)).toBeInTheDocument()
    expect(screen.queryByText(/cannot be undone/)).toBeNull()
    expect(fetchMock.mock.calls).toHaveLength(callsBefore)

    // The dialog is a portal — `container` from render() would be empty and
    // the audit vacuous, so the portalled dialog itself is what gets audited.
    // (Not `document.body`: radix's own focus guards are focusable
    // aria-hidden spans, an axe violation this component cannot fix.)
    await expectNoA11yViolations(screen.getByRole('dialog'))

    await userEvent.click(screen.getByRole('button', { name: 'Delete repository' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/repositories/r1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    )
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('tells the truth about a folder repository instead of the git sentence', async () => {
    renderDialog(FOLDER)

    await userEvent.click(screen.getByRole('button', { name: 'Delete Notes' }))

    expect(screen.getByText(/the folder on the server is not read again/)).toBeInTheDocument()
    expect(screen.queryByText(/the remote and its history/)).toBeNull()
  })

  it('keeps a failed delete on screen with the reason instead of navigating away', async () => {
    const { onDeleted } = renderDialog(GIT, { del: () => mockJsonResponse(404, { error: 'not found' }) })

    await userEvent.click(screen.getByRole('button', { name: 'Delete Chapters' }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete repository' }))

    expect(await screen.findByText('not found')).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
