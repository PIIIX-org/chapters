import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { ToastProvider } from './Toast.js'
import { toast, toastStore } from '../../lib/toast.js'

describe('Toast notification system', () => {
  beforeEach(() => {
    toastStore.clear()
  })

  afterEach(() => {
    toastStore.clear()
    vi.useRealTimers()
  })

  it('renders nothing when no toasts are active', () => {
    const { container } = render(
      <ToastProvider>
        <div>App Content</div>
      </ToastProvider>,
    )

    expect(screen.getByText('App Content')).toBeInTheDocument()
    expect(container.querySelector('[aria-label="Notifications"]')).toBeNull()
  })

  it('dispatches and displays success toast', () => {
    render(
      <ToastProvider>
        <button onClick={() => toast.success('Note saved', 'Saved successfully to disk.')}>
          Trigger
        </button>
      </ToastProvider>,
    )

    act(() => {
      toast.success('Note saved', 'Saved successfully to disk.')
    })

    expect(screen.getByText('Note saved')).toBeInTheDocument()
    expect(screen.getByText('Saved successfully to disk.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('dispatches error toast with role="alert"', () => {
    render(
      <ToastProvider>
        <div>Content</div>
      </ToastProvider>,
    )

    act(() => {
      toast.error('Sync failed', 'Network disconnected.')
    })

    expect(screen.getByText('Sync failed')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('removes toast when dismiss button is clicked', async () => {
    const user = userEvent.setup()

    render(
      <ToastProvider>
        <div>Content</div>
      </ToastProvider>,
    )

    act(() => {
      toast.info('Update ready')
    })

    expect(screen.getByText('Update ready')).toBeInTheDocument()

    const dismissBtn = screen.getByRole('button', { name: /Dismiss notification/i })
    await user.click(dismissBtn)

    expect(screen.queryByText('Update ready')).not.toBeInTheDocument()
  })

  it('auto-dismisses toast after duration', () => {
    vi.useFakeTimers()

    render(
      <ToastProvider>
        <div>Content</div>
      </ToastProvider>,
    )

    act(() => {
      toast.warning('Expiring link', 'Expires in 5 minutes', 2000)
    })

    expect(screen.getByText('Expiring link')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(screen.queryByText('Expiring link')).not.toBeInTheDocument()
  })

  it('limits to 5 visible toasts at most', () => {
    render(
      <ToastProvider>
        <div>Content</div>
      </ToastProvider>,
    )

    act(() => {
      for (let i = 1; i <= 8; i++) {
        toast.info(`Toast #${i}`)
      }
    })

    // Toasts 4-8 should be present, 1-3 dropped
    expect(screen.getByText('Toast #8')).toBeInTheDocument()
    expect(screen.getByText('Toast #4')).toBeInTheDocument()
    expect(screen.queryByText('Toast #1')).not.toBeInTheDocument()
    expect(screen.queryByText('Toast #2')).not.toBeInTheDocument()
    expect(screen.queryByText('Toast #3')).not.toBeInTheDocument()
  })

  it('passes accessibility audits with active toasts', async () => {
    const { container } = render(
      <ToastProvider>
        <div>Main content</div>
      </ToastProvider>,
    )

    act(() => {
      toast.success('All systems nominal', 'Observatory link established.')
      toast.error('Connection dropped', 'Retrying connection.')
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
