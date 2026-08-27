import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { expectNoA11yViolations } from '../../test/axe.js'
import { AuthSteps } from './AuthSteps.js'

describe('AuthSteps', () => {
  it('shows the whole route, so step 3 is visible before someone is stuck in it', async () => {
    const { container } = render(<AuthSteps current="Create account" />)

    // All four from the first screen: the point is that "Admin approval" is a
    // known part of the journey rather than a silence someone hits later.
    for (const step of ['Create account', 'Confirm your email', 'Admin approval', 'Sign in']) {
      expect(screen.getByText(step)).toBeInTheDocument()
    }
    await expectNoA11yViolations(container)
  })

  it('marks the current step for a screen reader, not by colour alone', () => {
    render(<AuthSteps current="Confirm your email" />)

    expect(screen.getByText('Confirm your email')).toHaveAttribute('aria-current', 'step')
    // And only that one — a component that marked everything, or nothing,
    // would pass an assertion that only looked at the current step.
    expect(screen.getByText('Create account')).not.toHaveAttribute('aria-current')
    expect(screen.getByText('Sign in')).not.toHaveAttribute('aria-current')
  })

  it('moves the marker with the step it is given', () => {
    // Two renders on purpose: a hardcoded step would satisfy either one alone.
    const { unmount } = render(<AuthSteps current="Create account" />)
    expect(screen.getByText('Create account')).toHaveAttribute('aria-current', 'step')
    unmount()

    render(<AuthSteps current="Admin approval" />)
    expect(screen.getByText('Admin approval')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText('Create account')).not.toHaveAttribute('aria-current')
  })
})
