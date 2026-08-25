import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoA11yViolations } from '../../test/axe.js'
import { ConfirmAction } from './ConfirmAction.js'

describe('ConfirmAction', () => {
  it('does nothing until confirmed, then calls back exactly once', async () => {
    const onConfirm = vi.fn()
    const { container } = render(
      <ConfirmAction
        label="Revoke"
        ariaLabel="Revoke Ada's access"
        consequence="Ada loses access immediately."
        onConfirm={onConfirm}
      />,
    )

    await expectNoA11yViolations(container)

    await userEvent.click(screen.getByRole('button', { name: "Revoke Ada's access" }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByText('Ada loses access immediately.')).toBeInTheDocument()
    await expectNoA11yViolations(container)

    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('cancel returns to rest without acting', async () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmAction
        label="Revoke"
        ariaLabel="Revoke Ada's access"
        consequence="Ada loses access immediately."
        onConfirm={onConfirm}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: "Revoke Ada's access" }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.queryByText('Ada loses access immediately.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: "Revoke Ada's access" })).toBeInTheDocument()
  })

  it('surfaces the failure in place instead of closing over it', async () => {
    render(
      <ConfirmAction
        label="Revoke"
        ariaLabel="Revoke Ada's access"
        consequence="Ada loses access immediately."
        onConfirm={() => {}}
        error="share not found"
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: "Revoke Ada's access" }))
    expect(screen.getByRole('alert')).toHaveTextContent('share not found')
  })
})
