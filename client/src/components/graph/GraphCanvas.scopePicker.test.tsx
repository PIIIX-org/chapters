import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useSearchParams } from 'react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { ScopePicker } from '../shell/ScopePicker.js'
import GraphCanvas from './GraphCanvas.js'

// #712: the Graph page mounts ScopePicker as GraphCanvas's leadControl
// (HomePage.tsx). The toolbar that holds it scrolls horizontally
// (overflow-x-auto, which forces overflow-y to auto too), so a dropdown
// positioned inside it is clipped to the toolbar's height and never shows.
// ScopePicker.test.tsx mounts the picker alone and cannot see that, so these
// tests mount it where it really lives.
//
// happy-dom does no layout, so clipping can't be measured. What decides
// clipping is containment: an absolutely positioned box is cut off by any
// overflow ancestor between it and its containing block. A list rendered
// outside GraphCanvas's whole subtree (a portal) has no such ancestor.

const VAULTS = [
  { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' },
  { id: 'v2', name: 'Recipes', ownerId: 'u1', mergeable: true, access: 'owner' },
]

const GRAPH = {
  aggregated: true,
  nodes: [
    { id: 'c0', community: 0, size: 4, noteCount: 3, codeCount: 1, lastActivity: '2026-08-01T00:00:00.000Z' },
    { id: 'c1', community: 1, size: 9, noteCount: 5, codeCount: 4, lastActivity: '2026-08-10T00:00:00.000Z' },
  ],
  edges: [{ source: 'c0', target: 'c1', weight: 2 }],
  cappedGroups: [],
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/trash')) return Promise.resolve(mockJsonResponse(200, []))
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, VAULTS))
      if (url.startsWith('/api/graph/perspectives')) return Promise.resolve(mockJsonResponse(200, []))
      return Promise.resolve(mockJsonResponse(200, GRAPH))
    }),
  )
}

function VaultParam() {
  const [params] = useSearchParams()
  return <div data-testid="vault-param">{params.get('vault') ?? ''}</div>
}

function renderGraphWithPicker(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <GraphCanvas leadControl={<ScopePicker />} />
        <VaultParam />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function openPicker(name: string) {
  const user = userEvent.setup()
  const trigger = await screen.findByRole('button', { name })
  await waitFor(() => expect(trigger).not.toBeDisabled())
  await user.click(trigger)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  return { user, trigger }
}

describe('ScopePicker inside GraphCanvas (#712)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the open list outside the graph toolbar, so its overflow cannot clip it', async () => {
    stubFetch()
    renderGraphWithPicker('/')
    const { trigger } = await openPicker('All vaults')

    const canvas = await screen.findByTestId('graph-canvas')
    // The trigger itself still sits in the graph's toolbar...
    expect(canvas.contains(trigger)).toBe(true)
    // ...but the list it opens must not be inside any of the graph's
    // containers.
    const listbox = screen.getByRole('listbox', { name: 'Scope' })
    expect(canvas.contains(listbox)).toBe(false)
    const panel = screen.getByRole('dialog', { name: 'Choose scope' })
    expect(trigger).toHaveAttribute('aria-controls', panel.id)
    expect(panel).toContainElement(listbox)
  })

  it('choosing a vault from the list sets the vault scope and closes the list', async () => {
    stubFetch()
    renderGraphWithPicker('/')
    const { user, trigger } = await openPicker('All vaults')

    await user.click(screen.getByRole('option', { name: 'Recipes' }))

    await waitFor(() => expect(screen.getByTestId('vault-param')).toHaveTextContent('v2'))
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('Vault settings and + New vault are reachable from the open list', async () => {
    stubFetch()
    renderGraphWithPicker('/?vault=v1')
    await openPicker('Engineering')

    const canvas = screen.getByTestId('graph-canvas')
    const settings = screen.getByRole('button', { name: 'Vault settings' })
    const newVault = screen.getByRole('button', { name: '+ New vault' })
    expect(canvas.contains(settings)).toBe(false)
    expect(canvas.contains(newVault)).toBe(false)
  })

  it('the open list stays reachable from the keyboard', async () => {
    // A portalled list sits at the end of <body>, no longer next to the
    // trigger in tab order; opening it must still put the keyboard user
    // one Tab (or less) away from its options, not on the next toolbar
    // button.
    stubFetch()
    renderGraphWithPicker('/')
    const user = userEvent.setup()
    const trigger = await screen.findByRole('button', { name: 'All vaults' })
    await waitFor(() => expect(trigger).not.toBeDisabled())
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    await user.tab()

    expect(screen.getByRole('listbox', { name: 'Scope' }).contains(document.activeElement)).toBe(true)
  })
})
