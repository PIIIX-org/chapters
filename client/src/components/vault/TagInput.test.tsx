import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TagInput } from './TagInput'

describe('TagInput', () => {
  it('renders existing tags as chips', () => {
    render(<TagInput value={['alpha', 'beta']} onChange={vi.fn()} />)
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
  })

  it('adds a trimmed tag on Enter and clears the input', () => {
    const onChange = vi.fn()
    render(<TagInput value={['alpha']} onChange={onChange} />)
    const input = screen.getByPlaceholderText('Add tag…')
    fireEvent.change(input, { target: { value: '  gamma  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['alpha', 'gamma'])
  })

  it('does not add a duplicate tag', () => {
    const onChange = vi.fn()
    render(<TagInput value={['alpha']} onChange={onChange} />)
    const input = screen.getByPlaceholderText('Add tag…')
    fireEvent.change(input, { target: { value: 'alpha' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes a tag when its remove button is clicked', () => {
    const onChange = vi.fn()
    render(<TagInput value={['alpha', 'beta']} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Remove alpha'))
    expect(onChange).toHaveBeenCalledWith(['beta'])
  })

  it('shows no input and no remove buttons when disabled', () => {
    render(<TagInput value={['alpha']} onChange={vi.fn()} disabled />)
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Add tag…')).toBeNull()
    expect(screen.queryByLabelText('Remove alpha')).toBeNull()
  })
})
