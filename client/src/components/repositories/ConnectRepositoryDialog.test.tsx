import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { Repository } from '../../api/repositories.js'
import { ConnectRepositoryDialog } from './ConnectRepositoryDialog.js'

const CREATED: Repository = {
  id: 'r1',
  name: 'chapters',
  ownerId: 'u1',
  ingestionMethod: 'git',
  gitUrl: 'https://github.com/PIIIX-org/chapters.git',
  localPath: null,
  defaultBranch: null,
  mergeable: true,
  syncStatus: 'idle',
  lastSyncedAt: null,
  lastSyncError: null,
  lastWebhookAt: null,
  webhookConfigured: false,
  createdAt: '2026-08-25T09:00:00.000Z',
}

function stubFetch(makeResponse: () => Response = () => mockJsonResponse(200, CREATED)) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    // The create mutation invalidates the list; answer it quietly.
    if (url === '/api/repositories') return Promise.resolve(makeResponse())
    throw new Error(`unstubbed request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderDialog() {
  const onOpenChange = vi.fn()
  const onConnected = vi.fn()
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ConnectRepositoryDialog open onOpenChange={onOpenChange} onConnected={onConnected} />
    </QueryClientProvider>,
  )
  return { ...result, onOpenChange, onConnected }
}

function postBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
  return JSON.parse((call![1] as RequestInit).body as string)
}

const GIT = { name: 'Git remote' }
const LOCAL = { name: 'Folder on this server' }
const AGENT = { name: 'Agent push' }
const SUBMIT = { name: 'Connect repository' }

describe('ConnectRepositoryDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the git branch fields, states where the credential goes, and hands the repository back', async () => {
    const fetchMock = stubFetch()
    const { container, onConnected, onOpenChange } = renderDialog()

    await userEvent.type(screen.getByLabelText('Repository name'), 'chapters')
    await userEvent.type(screen.getByLabelText('Git remote URL'), 'https://github.com/PIIIX-org/chapters.git')
    await userEvent.type(screen.getByLabelText('Access token or password (optional)'), 'ghp_secret')
    // The one moment the credential is visible to anyone, said where it is typed.
    expect(screen.getByText(/stored encrypted and never shown again/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', SUBMIT))

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(CREATED))
    expect(postBody(fetchMock)).toEqual({
      name: 'chapters',
      ingestionMethod: 'git',
      gitUrl: 'https://github.com/PIIIX-org/chapters.git',
      gitCredential: 'ghp_secret',
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)

    await expectNoA11yViolations(container)
  })

  it('omits the credential entirely when none was typed, rather than sending an empty one', async () => {
    const fetchMock = stubFetch()
    renderDialog()

    await userEvent.type(screen.getByLabelText('Repository name'), 'chapters')
    await userEvent.type(screen.getByLabelText('Git remote URL'), 'https://github.com/PIIIX-org/chapters.git')
    await userEvent.click(screen.getByRole('button', SUBMIT))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(postBody(fetchMock)).not.toHaveProperty('gitCredential')
  })

  it('carries only the folder path once the method is switched, never a git URL left behind', async () => {
    const fetchMock = stubFetch(() =>
      mockJsonResponse(200, { ...CREATED, ingestionMethod: 'local_path', gitUrl: null, localPath: '/repos/api' }),
    )
    const { container } = renderDialog()

    await userEvent.type(screen.getByLabelText('Repository name'), 'api')
    // Typed under git, then abandoned — it must not reach the server.
    await userEvent.type(screen.getByLabelText('Git remote URL'), 'https://github.com/PIIIX-org/abandoned.git')
    await userEvent.click(screen.getByRole('radio', LOCAL))

    expect(screen.queryByLabelText('Git remote URL')).toBeNull()
    expect(screen.getByText(/resolves outside it is refused/i)).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Folder path'), 'api')
    await userEvent.click(screen.getByRole('button', SUBMIT))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(postBody(fetchMock)).toEqual({ name: 'api', ingestionMethod: 'local_path', localPath: 'api' })

    await expectNoA11yViolations(container)
  })

  it('asks for nothing but a name for agent push, and names the sync token as the next step', async () => {
    const fetchMock = stubFetch(() =>
      mockJsonResponse(200, { ...CREATED, ingestionMethod: 'agent_push', gitUrl: null }),
    )
    renderDialog()

    await userEvent.click(screen.getByRole('radio', AGENT))
    expect(screen.queryByLabelText('Git remote URL')).toBeNull()
    expect(screen.queryByLabelText('Folder path')).toBeNull()
    expect(screen.getByText(/create a sync token/i)).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Repository name'), 'agent-fed')
    await userEvent.click(screen.getByRole('button', SUBMIT))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(postBody(fetchMock)).toEqual({ name: 'agent-fed', ingestionMethod: 'agent_push' })
  })

  it('refuses a git connection with no URL without touching the network', async () => {
    const fetchMock = stubFetch()
    const { onOpenChange } = renderDialog()

    await userEvent.type(screen.getByLabelText('Repository name'), 'chapters')
    expect(screen.getByRole('radio', GIT)).toBeChecked()
    await userEvent.click(screen.getByRole('button', SUBMIT))

    expect(await screen.findByRole('alert')).toHaveTextContent('A git remote needs a clone URL.')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and shows the server rejection inline', async () => {
    stubFetch(() => mockJsonResponse(400, { error: 'localPath must resolve under the configured local repos root' }))
    const { onOpenChange, onConnected } = renderDialog()

    await userEvent.click(screen.getByRole('radio', LOCAL))
    await userEvent.type(screen.getByLabelText('Repository name'), 'escape')
    await userEvent.type(screen.getByLabelText('Folder path'), '../../etc')
    await userEvent.click(screen.getByRole('button', SUBMIT))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'localPath must resolve under the configured local repos root',
    )
    expect(onConnected).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
