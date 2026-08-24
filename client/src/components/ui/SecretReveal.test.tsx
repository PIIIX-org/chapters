import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoA11yViolations } from '../../test/axe'
import { SecretReveal } from './SecretReveal'

function renderReveal(onDismiss = vi.fn()) {
  const result = render(
    <SecretReveal
      label="Token for &quot;Claude&quot;"
      secret="mcp_live_abc123"
      note="Paste it into the MCP client's config now."
      onDismiss={onDismiss}
    />,
  )
  return { ...result, onDismiss }
}

describe('SecretReveal', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the secret, the warning, and the caller note', () => {
    renderReveal()

    expect(screen.getByText('mcp_live_abc123')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This is the only time this value is shown — it is stored hashed and cannot be retrieved again.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText("Paste it into the MCP client's config now.")).toBeInTheDocument()
  })

  it('copy calls navigator.clipboard.writeText with the exact secret, not the label', async () => {
    // userEvent.setup() installs its own clipboard stub for keyboard
    // copy/paste emulation — spy AFTER setup so ours is the one the
    // component sees, not the other way round.
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    renderReveal()

    await user.click(screen.getByRole('button', { name: /copy/i }))

    expect(writeText).toHaveBeenCalledWith('mcp_live_abc123')
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('Token for'))
  })

  it('copy is a graceful no-op when the Clipboard API is missing', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    renderReveal()

    await expect(user.click(screen.getByRole('button', { name: /copy/i }))).resolves.not.toThrow()
  })

  it('Done clears the secret from the DOM and fires onDismiss — it holds nothing after dismissal', async () => {
    const user = userEvent.setup()
    const { container, onDismiss } = renderReveal()

    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('mcp_live_abc123')
  })

  it('has no accessibility violations', async () => {
    const { container } = renderReveal()
    await expectNoA11yViolations(container)
  })
})
