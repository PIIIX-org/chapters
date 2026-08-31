import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { expectNoA11yViolations } from '../../test/axe.js'
import { AuthFrame } from './AuthFrame.js'

describe('AuthFrame', () => {
  it('frames the page: wordmark, eyebrow, title heading, content', async () => {
    const { container } = render(
      <AuthFrame eyebrow="sign in" title="Log in">
        <p>form goes here</p>
      </AuthFrame>,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument()
    expect(screen.getByText('Chapters')).toBeInTheDocument()
    expect(screen.getByText('sign in')).toBeInTheDocument()
    expect(screen.getByText('form goes here')).toBeInTheDocument()
    // The whole card sits in the page's main landmark — these pages have no shell.
    expect(screen.getByRole('main')).toBeInTheDocument()

    await expectNoA11yViolations(container)
  })

  it('shows the steps indicator only when a step is given', () => {
    const { rerender } = render(
      <AuthFrame eyebrow="sign in" title="Log in">
        <p>content</p>
      </AuthFrame>,
    )
    expect(screen.queryByRole('list', { name: 'Getting in' })).toBeNull()

    rerender(
      <AuthFrame eyebrow="new account" title="Create an account" step="Create account">
        <p>content</p>
      </AuthFrame>,
    )
    expect(screen.getByRole('list', { name: 'Getting in' })).toBeInTheDocument()
    expect(screen.getByText('Create account')).toHaveAttribute('aria-current', 'step')
  })
})
