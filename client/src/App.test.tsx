import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

describe('App', () => {
  it('renders the Chapters wordmark in the display font', () => {
    render(<App />)
    const wordmark = screen.getByText('Chapters')
    expect(wordmark).toHaveClass('font-display')
  })
})
