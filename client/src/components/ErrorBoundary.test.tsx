import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, createMemoryRouter, RouterProvider } from 'react-router'
import { axe } from 'vitest-axe'
import { ErrorBoundary, RouteErrorBoundary, ErrorFallback } from './ErrorBoundary.js'

function Bomb({ shouldThrow }: { shouldThrow?: boolean }) {
  if (shouldThrow) {
    throw new Error('Test explosion')
  }
  return <div>Safe content</div>
}

describe('ErrorBoundary', () => {
  const originalError = console.error

  beforeEach(() => {
    // Suppress console.error during expected throw tests
    console.error = vi.fn()
  })

  afterEach(() => {
    console.error = originalError
  })

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    )

    expect(screen.getByText('Safe content')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('catches child throw and renders fallback alert UI', async () => {
    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Bomb shouldThrow={true} />
        </ErrorBoundary>
      </MemoryRouter>,
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Something interrupted this view')).toBeInTheDocument()
    expect(
      screen.getByText(/Your notes, vault data, and edits remain safely persisted/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reload View/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Return Home/i })).toHaveAttribute('href', '/')
  })

  it('reveals telemetry diagnostics when clicked', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Bomb shouldThrow={true} />
        </ErrorBoundary>
      </MemoryRouter>,
    )

    const toggle = screen.getByRole('button', { name: /Telemetry Diagnostics/i })
    expect(screen.queryByText('Error: Test explosion')).not.toBeInTheDocument()

    await user.click(toggle)
    expect(screen.getByText('Error: Test explosion')).toBeInTheDocument()
  })

  it('supports custom function fallback with reset capability', async () => {
    const user = userEvent.setup()
    let shouldExplode = true

    function DynamicBomb() {
      if (shouldExplode) throw new Error('Dynamic boom')
      return <div>Recovered content</div>
    }

    render(
      <ErrorBoundary
        fallback={(err, reset) => (
          <div>
            <span>Custom: {err.message}</span>
            <button
              onClick={() => {
                shouldExplode = false
                reset()
              }}
            >
              Custom Reset
            </button>
          </div>
        )}
      >
        <DynamicBomb />
      </ErrorBoundary>,
    )

    expect(screen.getByText('Custom: Dynamic boom')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Custom Reset' }))
    expect(screen.getByText('Recovered content')).toBeInTheDocument()
  })

  it('has no accessibility violations in fallback state', async () => {
    const { container } = render(
      <MemoryRouter>
        <ErrorFallback error={new Error('Axe check')} />
      </MemoryRouter>,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

describe('RouteErrorBoundary', () => {
  const originalError = console.error

  beforeEach(() => {
    console.error = vi.fn()
  })

  afterEach(() => {
    console.error = originalError
  })

  it('renders 404 Waypoint Unreachable for 404 RouteErrorResponse', async () => {
    const router = createMemoryRouter(
      [
        {
          path: '/',
          errorElement: <RouteErrorBoundary />,
          loader: () => {
            throw new Response('Not Found', { status: 404, statusText: 'Sector Unknown' })
          },
          element: <div>Home</div>,
        },
      ],
      { initialEntries: ['/'] },
    )

    render(<RouterProvider router={router} />)
    expect(await screen.findByText('Waypoint Unreachable')).toBeInTheDocument()
    expect(await screen.findByText('Sector Unknown')).toBeInTheDocument()
    expect(await screen.findByText(/Status 404/i)).toBeInTheDocument()
  })

  it('renders 403 Access Restricted for 403 RouteErrorResponse', async () => {
    const router = createMemoryRouter(
      [
        {
          path: '/',
          errorElement: <RouteErrorBoundary />,
          loader: () => {
            throw new Response('Forbidden', { status: 403 })
          },
          element: <div>Home</div>,
        },
      ],
      { initialEntries: ['/'] },
    )

    render(<RouterProvider router={router} />)
    expect(await screen.findByText('Access Restricted')).toBeInTheDocument()
    expect(await screen.findByText(/Status 403/i)).toBeInTheDocument()
  })

  it('renders ErrorFallback for unhandled Error throws', async () => {
    const router = createMemoryRouter(
      [
        {
          path: '/',
          errorElement: <RouteErrorBoundary />,
          loader: () => {
            throw new Error('Loader crashed')
          },
          element: <div>Home</div>,
        },
      ],
      { initialEntries: ['/'] },
    )

    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(await screen.findByText('Something interrupted this view')).toBeInTheDocument()
  })
})
