import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CustomColorPickerDialog } from './CustomColorPickerDialog.js'

describe('CustomColorPickerDialog component', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders correctly with title and inputs', () => {
    render(
      <CustomColorPickerDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Choose Vault Color"
        initialColor="#3b82f6"
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Choose Vault Color' })).toBeInTheDocument()
    expect(screen.getByLabelText(/hex code/i)).toHaveValue('#3b82f6')
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('allows pasting a hex code and confirming it', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <CustomColorPickerDialog
        open={true}
        onOpenChange={onOpenChange}
        initialColor="#3b82f6"
        onConfirm={onConfirm}
      />,
    )

    const hexInput = screen.getByLabelText(/hex code/i)
    fireEvent.change(hexInput, { target: { value: '#10b981' } })

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onConfirm).toHaveBeenCalledWith('#10b981')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('allows adding a custom color to the saved palette and saving to localStorage', () => {
    render(
      <CustomColorPickerDialog
        open={true}
        onOpenChange={vi.fn()}
        initialColor="#e11d48"
        onConfirm={vi.fn()}
      />,
    )

    const saveBtn = screen.getByRole('button', { name: 'Add to saved palette' })
    fireEvent.click(saveBtn)

    // Check saved in localStorage
    const saved = JSON.parse(localStorage.getItem('chapters_custom_palette') || '[]')
    expect(saved).toContain('#e11d48')

    // Click saved color swatch
    const swatch = screen.getByTitle('Select #e11d48')
    expect(swatch).toBeInTheDocument()
    fireEvent.click(swatch)
    expect(screen.getByLabelText(/hex code/i)).toHaveValue('#e11d48')
  })

  it('cancels without calling onConfirm', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <CustomColorPickerDialog
        open={true}
        onOpenChange={onOpenChange}
        initialColor="#3b82f6"
        onConfirm={onConfirm}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
