import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { axe } from 'vitest-axe'
import { NotFoundPage } from './NotFoundPage.js'

describe('NotFoundPage', () => {
  it('renders 404 Waypoint Unreachable and navigation routes', () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    )

    expect(screen.getByText('Error 404')).toBeInTheDocument()
    expect(screen.getByText('Waypoint Unreachable')).toBeInTheDocument()
    expect(
      screen.getByText(/The celestial coordinates for this waypoint do not exist/),
    ).toBeInTheDocument()

    expect(screen.getByRole('link', { name: /Observatory Home/i })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: /Browse Vaults/i })).toHaveAttribute('href', '/vaults')
    expect(screen.getByRole('link', { name: /Repositories/i })).toHaveAttribute('href', '/repos')
  })

  it('passes accessibility audits', async () => {
    const { container } = render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
