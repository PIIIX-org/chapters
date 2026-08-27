import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { FileSymbol } from '../../api/repositories.js'
import { SymbolOutline } from './SymbolOutline.js'

// Two symbols that differ on every axis the component renders — name, kind
// and line. A pair of identical rows could not tell a component that reads
// each symbol from one that renders the first one twice.
const SYMBOLS: FileSymbol[] = [
  { name: 'alpha', kind: 'function', startLine: 2, endLine: 4 },
  { name: 'Beta', kind: 'class', startLine: 5, endLine: 9 },
]

describe('SymbolOutline', () => {
  it('lists every symbol with its own kind and start line', async () => {
    const { container } = render(<SymbolOutline symbols={SYMBOLS} onSelect={vi.fn()} />)

    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toBe('alphafunction2')
    expect(items[1]!.textContent).toBe('Betaclass5')

    await expectNoA11yViolations(container)
  })

  it('explains an empty outline instead of rendering an empty list', () => {
    render(<SymbolOutline symbols={[]} onSelect={vi.fn()} />)

    expect(screen.getByText(/No symbols in this file/)).toBeInTheDocument()
    // The load-bearing half: no bare list, and nothing that looks like a row.
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('reports the clicked symbol’s start line, not the first one’s', async () => {
    const onSelect = vi.fn()
    render(<SymbolOutline symbols={SYMBOLS} onSelect={onSelect} />)

    await userEvent.click(screen.getByRole('button', { name: 'Beta, class, line 5' }))

    expect(onSelect).toHaveBeenCalledWith(5)
    expect(onSelect).not.toHaveBeenCalledWith(2)
  })
})
