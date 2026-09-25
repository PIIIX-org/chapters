import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FileText } from 'lucide-react'
import { ContextPanel, Inspector, PanelRailButton, PanelRailNav } from './ShellPanels'
import { TooltipProvider } from '../ui/tooltip'
import { expectNoA11yViolations } from '../../test/axe'

describe('ContextPanel / Inspector outside a shell', () => {
  it('render inline as labelled asides, so a page is testable on its own', async () => {
    const { container } = render(
      <>
        <ContextPanel label="Files">
          <p>tree</p>
        </ContextPanel>
        <Inspector label="Connection">
          <p>sync</p>
        </Inspector>
        <main>content</main>
      </>,
    )
    const files = screen.getByRole('complementary', { name: 'Files' })
    expect(files).toHaveAttribute('data-shell-fallback')
    expect(files).toHaveTextContent('tree')
    expect(screen.getByRole('complementary', { name: 'Connection' })).toHaveTextContent('sync')
    await expectNoA11yViolations(container)
  })

  it('renders collapsed rail nav and button with accessible label', async () => {
    const { container } = render(
      <TooltipProvider>
        <PanelRailNav label="Tools">
          <PanelRailButton
            icon={FileText}
            label="Documents"
            active={true}
          />
        </PanelRailNav>
      </TooltipProvider>,
    )
    const button = screen.getByRole('button', { name: 'Documents' })
    expect(button).toBeInTheDocument()
    expect(button).toHaveAttribute('aria-current', 'page')
    await expectNoA11yViolations(container)
  })
})
