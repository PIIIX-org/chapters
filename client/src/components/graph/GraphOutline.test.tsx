import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { CommunityNode } from '../../api/graph.js'
import { GraphOutline } from './GraphOutline.js'

const COMMUNITIES: CommunityNode[] = [
  { id: 'community:0', community: 0, size: 4, noteCount: 3, codeCount: 1, lastActivity: '2026-08-01T00:00:00.000Z' },
  {
    id: 'community:3',
    community: 3,
    size: 9140,
    noteCount: 400,
    codeCount: 12,
    lastActivity: '2026-03-14T00:00:00.000Z',
  },
]

const MEMBER_GRAPH = {
  nodes: [
    {
      id: 'n1',
      resourceType: 'note',
      resourceId: 'r1',
      path: 'notes/roadmap.md',
      type: null,
      tags: [],
      timestamp: null,
      updatedAt: null,
      community: 3,
    },
    {
      id: 'n2',
      resourceType: 'code',
      resourceId: 'r2',
      path: 'src/server/index.ts',
      type: null,
      tags: [],
      timestamp: null,
      updatedAt: null,
      community: 3,
    },
  ],
  edges: [],
  cappedGroups: [],
  memberTotal: 9140,
}

const AGGREGATED_GRAPH = { aggregated: true, nodes: COMMUNITIES, edges: [], cappedGroups: [] }

function stubFetch() {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('community=3')) return Promise.resolve(mockJsonResponse(200, MEMBER_GRAPH))
    return Promise.resolve(mockJsonResponse(200, AGGREGATED_GRAPH))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// GraphOutline is a fully controlled component — expansion state lives in
// the parent (GraphCanvas in production). This harness plays that role so
// the component is exercised exactly as it will really be driven: a canvas
// tap and a keyboard activation both end up calling the same setter.
function Harness() {
  const [expandedCommunity, setExpandedCommunity] = useState<number | null>(null)
  return (
    <GraphOutline
      communities={COMMUNITIES}
      expandedCommunity={expandedCommunity}
      onExpand={setExpandedCommunity}
      onCollapse={() => setExpandedCommunity(null)}
    />
  )
}

// Drives real Tab keypresses (not a hand-picked `.focus()` call) until the
// button with this accessible name has focus. A canvas-only implementation,
// or one that doesn't wire real <button> elements into the tab order, can't
// pass a test built this way.
async function tabToButton(user: ReturnType<typeof userEvent.setup>, name: RegExp): Promise<HTMLElement> {
  for (let i = 0; i < 20; i++) {
    await user.tab()
    const active = document.activeElement
    if (active instanceof HTMLElement && active.tagName === 'BUTTON' && name.test(active.textContent ?? '')) {
      return active
    }
  }
  throw new Error(`Tabbed 20 times without focusing a button matching ${name}`)
}

function renderOutline() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/?vault=v1']}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('GraphOutline', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists each community with identity and stats', async () => {
    stubFetch()
    renderOutline()

    expect(
      await screen.findByRole('button', { name: 'Community 3 — 400 notes, 12 code files, last active 14 March 2026' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Community 0 — 3 notes, 1 code file, last active 1 August 2026' }),
    ).toBeInTheDocument()
  })

  it('tabbing to a community button and pressing Enter fetches its members and shows their paths', async () => {
    const fetchMock = stubFetch()
    const user = userEvent.setup()
    renderOutline()

    await screen.findByRole('button', { name: /Community 3/ })
    const community3Button = await tabToButton(user, /Community 3/)
    expect(community3Button).toHaveAttribute('aria-expanded', 'false')

    await user.keyboard('{Enter}')

    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[0] as string).includes('community=3'))).toBe(true))

    expect(await screen.findByText('notes/roadmap.md')).toBeInTheDocument()
    expect(screen.getByText('src/server/index.ts')).toBeInTheDocument()

    // Task 1's truncation, announced in the live region.
    expect(await screen.findByRole('status')).toHaveTextContent('Expanded community 3, showing 2 of 9,140.')

    // Focus moved off the button and onto the members heading.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Community 3 members' }))
  })

  it('"Back to all communities" restores the aggregated list and returns focus to the button that opened it', async () => {
    stubFetch()
    const user = userEvent.setup()
    renderOutline()

    await screen.findByRole('button', { name: /Community 3/ })
    await tabToButton(user, /Community 3/)
    await user.keyboard('{Enter}')

    const backButton = await screen.findByRole('button', { name: 'Back to all communities' })
    await user.click(backButton)

    // The aggregated list is what's left; the members section is gone.
    expect(screen.queryByRole('heading', { name: 'Community 3 members' })).toBeNull()
    expect(screen.getByRole('button', { name: /Community 0/ })).toBeInTheDocument()

    // Focus landed back on the exact button that opened this community —
    // not on <body>.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Community 3/ }))
    expect(document.activeElement).not.toBe(document.body)
  })

  it('has no accessibility violations collapsed', async () => {
    stubFetch()
    const { container } = renderOutline()
    await screen.findByRole('button', { name: /Community 3/ })
    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations expanded', async () => {
    stubFetch()
    const user = userEvent.setup()
    const { container } = renderOutline()

    const community3Button = await screen.findByRole('button', { name: /Community 3/ })
    community3Button.focus()
    await user.keyboard('{Enter}')
    await screen.findByText('notes/roadmap.md')

    await expectNoA11yViolations(container)
  })
})
