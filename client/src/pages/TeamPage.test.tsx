import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { render, screen, within } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api.js'
import { expectNoA11yViolations } from '../test/axe.js'
import { TeamPage } from './TeamPage.js'

const TEAMS = [{ id: 't1', name: 'Engineering', role: 'owner' as const }]

const MEMBERS = [
  { userId: 'u1', email: 'ada@example.com', role: 'owner' },
  { userId: 'u2', email: 'grace@example.com', role: 'member' },
  { userId: 'u3', email: 'idle@example.com', role: 'member' },
]

// Deliberately shaped so a stats bug that leaked per-note detail downstream
// (a `recentNotePaths` array, a `lastNoteTitle` string) would fail loudly
// against the "no per-note text anywhere" assertion below. These two fields
// are NOT part of the real TeamMemberStats response (the server never sends
// per-note detail from /teams/:id/stats — see server/test/teams.test.ts:235)
// — they exist only here, so that if TeamPage ever started reading and
// rendering them, this test would catch it instead of vacuously passing.
const STATS = [
  {
    userId: 'u1',
    email: 'ada@example.com',
    notesTouched: 40,
    vaultsTouched: 3,
    lastActivityAt: '2026-08-01T00:00:00.000Z',
    recentNotePaths: ['people/ada.md', 'projects/roadmap.md'],
    lastNoteTitle: 'a-secret-title',
  },
  {
    userId: 'u2',
    email: 'grace@example.com',
    notesTouched: 5,
    vaultsTouched: 1,
    lastActivityAt: '2026-07-15T00:00:00.000Z',
    recentNotePaths: ['journal/2026-07-15.md'],
    lastNoteTitle: 'grace-private-note',
  },
  {
    userId: 'u3',
    email: 'idle@example.com',
    notesTouched: 0,
    vaultsTouched: 0,
    lastActivityAt: null,
    recentNotePaths: [],
    lastNoteTitle: null,
  },
]

// Three queries share this page (teams, members, stats) — mockResolvedValue
// would hand out the same Response object (and drained body) to every call,
// so branch on the URL and build a fresh Response each time.
function stubFetch({
  teams = TEAMS,
  members = MEMBERS,
  stats = STATS,
  statsStatus = 200,
}: {
  teams?: typeof TEAMS
  members?: typeof MEMBERS
  stats?: typeof STATS
  statsStatus?: number
} = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/teams/t1/stats')) {
      return Promise.resolve(
        statsStatus === 200 ? mockJsonResponse(200, stats) : mockJsonResponse(statsStatus, { error: 'boom' }),
      )
    }
    if (url.includes('/teams/t1/members')) return Promise.resolve(mockJsonResponse(200, members))
    if (url.includes('/teams')) return Promise.resolve(mockJsonResponse(200, teams))
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/team']}>
        <TeamPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('TeamPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders one roster row per member, including an idle one, with "No activity yet"', async () => {
    stubFetch()
    renderPage()

    // Scoped to the roster table — TeamManagement (below it) re-lists the
    // same emails for member management, so an unscoped query is ambiguous.
    const table = await screen.findByRole('table')
    expect(within(table).getByText('ada@example.com')).toBeInTheDocument()
    expect(within(table).getByText('grace@example.com')).toBeInTheDocument()
    expect(within(table).getByText('idle@example.com')).toBeInTheDocument()

    const idleRow = within(table).getByText('idle@example.com').closest('tr')!
    expect(within(idleRow).getByText('No activity yet')).toBeInTheDocument()
    // Both notesTouched and vaultsTouched render "0" for the idle member.
    expect(within(idleRow).getAllByText('0')).toHaveLength(2)
    expect(screen.queryByText(/invalid date/i)).toBeNull()
  })

  it('sizes the highest-mass member\'s circle strictly larger than the lowest-mass member\'s', async () => {
    stubFetch()
    const { container } = renderPage()

    await screen.findByRole('table')
    const circles = container.querySelectorAll('circle')
    expect(circles.length).toBe(3)

    const byTitle = (email: string) =>
      Array.from(circles).find((c) => c.querySelector('title')?.textContent?.includes(email))!

    const highest = byTitle('ada@example.com') // 40 notes touched — the max
    const lowest = byTitle('idle@example.com') // 0 notes touched — the min

    const highestR = Number(highest.getAttribute('r'))
    const lowestR = Number(lowest.getAttribute('r'))
    expect(highestR).toBeGreaterThan(lowestR)
  })

  it('shows no per-note detail anywhere in the rendered output', async () => {
    stubFetch()
    const { container } = renderPage()

    await screen.findByRole('table')

    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\.md\b/)
    expect(text).not.toMatch(/notePath/i)
    expect(text).not.toMatch(/note title/i)
    // Fixture-specific: catches the exact leaked values, not just the shape
    // of the field names above.
    expect(text).not.toMatch(/a-secret-title/)
    expect(text).not.toMatch(/grace-private-note/)
    expect(text).not.toMatch(/roadmap\.md/)
  })

  it('shows an error, not a false "no activity", when stats fails to load', async () => {
    stubFetch({ statsStatus: 500 })
    const { container } = renderPage()

    // By text, not the first role=alert on the page: the management panel
    // beside the roster has its own queries and its own alerts.
    const message = await screen.findByText(/couldn.t load this team.s roster/i)
    expect(message.closest('[role="alert"]')).not.toBeNull()

    // The roster must not render at all — never fall back to treating a
    // failed fetch as "everyone has zero activity".
    // Scoped to the roster's own landmark: the management panel beside it
    // legitimately lists members by email.
    const roster = within(screen.getByRole('region', { name: 'Roster' }))
    expect(roster.queryByText('ada@example.com')).toBeNull()
    expect(roster.queryByText('No activity yet')).toBeNull()

    await expectNoA11yViolations(container)
  })

  it('renders an empty state, not a blank page or a stuck spinner, for zero teams', async () => {
    stubFetch({ teams: [] })
    renderPage()

    expect(await screen.findByText(/no teams yet/i)).toBeInTheDocument()
    expect(
      screen.getByText(/teams are how several people reach a set of vaults at once/i),
    ).toBeInTheDocument()
  })

  it('has no accessibility violations once loaded', async () => {
    stubFetch()
    const { container } = renderPage()

    await screen.findByRole('table')
    await expectNoA11yViolations(container)
  })
})
