import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { PendingApprovalPage } from './PendingApprovalPage.js'

describe('PendingApprovalPage', () => {
  it('renders welcome message and explains approval process', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/pending-approval', state: { email: 'user@example.com' } }]}>
        <PendingApprovalPage />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: /Welcome to Chapters/i })).toBeInTheDocument()
    expect(screen.getByText(/Email confirmed/i)).toBeInTheDocument()
    expect(screen.getByText(/Waiting for approval/i)).toBeInTheDocument()
    expect(
      screen.getByText(/Wait for approval or contact your manager to speed up the process/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Already approved\? Sign in/i })).toBeInTheDocument()
  })
})
