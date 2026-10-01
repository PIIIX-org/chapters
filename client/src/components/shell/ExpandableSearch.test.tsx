import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '../ui/tooltip.js'
import { ShellProvider } from './ShellProvider.js'
import { ExpandableSearch } from './ExpandableSearch.js'

describe('ExpandableSearch', () => {
  it('renders command palette trigger with accessible name and title when expanded', () => {
    render(
      <TooltipProvider>
        <ShellProvider>
          <ExpandableSearch />
        </ShellProvider>
      </TooltipProvider>,
    )

    // Initially collapsed: search trigger button
    const searchBtn = screen.getByRole('button', { name: 'Open the command palette' })
    fireEvent.click(searchBtn)

    // Now expanded: has command palette shortcut button with accessible name and title
    const cmdPaletteBtn = screen.getByRole('button', { name: 'Open command palette' })
    expect(cmdPaletteBtn).toBeInTheDocument()
    expect(cmdPaletteBtn).toHaveAttribute('title', 'Open command palette')
  })
})
