import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

describe('App', () => {
  it('renders the Chapters wordmark', () => {
    render(<App />)
    expect(screen.getByText('Chapters')).toBeInTheDocument()
  })
})
