import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './button'

describe('Button', () => {
  it('renders its label and responds to clicks', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Sign in</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
