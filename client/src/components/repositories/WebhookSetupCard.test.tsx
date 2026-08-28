import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { Repository } from '../../api/repositories.js'
import { WebhookSetupCard } from './WebhookSetupCard.js'

type CardRepository = Pick<Repository, 'id' | 'ingestionMethod' | 'webhookConfigured'>

// Three fixtures along the two axes the card branches on: whether a secret
// already exists, and whether there is a git host to configure at all.
const UNCONFIGURED: CardRepository = { id: 'r1', ingestionMethod: 'git', webhookConfigured: false }
const CONFIGURED: CardRepository = { id: 'r1', ingestionMethod: 'git', webhookConfigured: true }
const FOLDER: CardRepository = { id: 'r2', ingestionMethod: 'local_path', webhookConfigured: false }

const SECRET = { secret: 'whsec_9f2c41ab', webhookPath: '/repositories/r1/webhook' }

function renderCard(repository: CardRepository, makeSecretResponse = () => mockJsonResponse(200, SECRET)) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/webhook-secret')) return Promise.resolve(makeSecretResponse())
    // The mutation invalidates the repository list; answer it quietly.
    if (url === '/api/repositories') return Promise.resolve(mockJsonResponse(200, []))
    throw new Error(`unstubbed request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <WebhookSetupCard repository={repository} />
    </QueryClientProvider>,
  )
  return { ...result, fetchMock }
}

const SET_UP = { name: 'Set up the webhook' }
const REGENERATE = { name: 'Regenerate the webhook secret' }

describe('WebhookSetupCard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers setup and names the polling fallback while no secret exists', async () => {
    const { container } = renderCard(UNCONFIGURED)

    expect(screen.getByRole('button', SET_UP)).toBeInTheDocument()
    expect(screen.getByText(/polls this remote on a schedule/)).toBeInTheDocument()
    // Nothing secret before it is asked for, and nothing to regenerate.
    expect(screen.queryByRole('button', REGENERATE)).toBeNull()
    expect(screen.queryByText(SECRET.secret)).toBeNull()

    await expectNoA11yViolations(container)
  })

  it('shows the secret and the path to paste it beside, then drops the secret on dismiss', async () => {
    renderCard(UNCONFIGURED)

    await userEvent.click(screen.getByRole('button', SET_UP))

    expect(await screen.findByText(SECRET.secret)).toBeInTheDocument()
    expect(screen.getByText(SECRET.webhookPath)).toBeInTheDocument()
    expect(screen.queryAllByText(SECRET.secret)).toHaveLength(1)

    await userEvent.click(screen.getByRole('button', { name: 'Done' }))

    // SecretReveal clears itself, so the load-bearing half is this card's own
    // state: the path it renders beside the secret goes too, and the card
    // falls back to its resting branch rather than an empty panel.
    expect(screen.queryByText(SECRET.secret)).toBeNull()
    expect(screen.queryByText(SECRET.webhookPath)).toBeNull()
    expect(screen.getByRole('button', SET_UP)).toBeInTheDocument()
  })

  it('says what regenerating breaks before it regenerates, and does not call until confirmed', async () => {
    const { container, fetchMock } = renderCard(CONFIGURED)

    // The already-configured branch: no setup button, a regenerate one instead.
    expect(screen.queryByRole('button', SET_UP)).toBeNull()
    await userEvent.click(screen.getByRole('button', REGENERATE))

    expect(screen.getByText(/keeps failing.*until you paste the new secret/s)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()

    await expectNoA11yViolations(container)

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate secret' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/repositories/r1/webhook-secret',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    expect(await screen.findByText(SECRET.secret)).toBeInTheDocument()
  })

  it('renders nothing for a repository with no git host to configure', () => {
    const { container } = renderCard(FOLDER)
    expect(container).toBeEmptyDOMElement()
  })

  it('surfaces a rejected request inline instead of an empty reveal', async () => {
    renderCard(UNCONFIGURED, () => mockJsonResponse(400, { error: 'webhooks only apply to git-sourced repositories' }))

    await userEvent.click(screen.getByRole('button', SET_UP))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'webhooks only apply to git-sourced repositories',
    )
    expect(screen.queryByText(SECRET.webhookPath)).toBeNull()
  })
})
