import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoA11yViolations } from '../../test/axe.js'
import { ColorModeToggle } from './ColorModeToggle.js'

// Renders the toggle plus a probe that reads the live URL search params via
// the same router context ColorModeToggle itself reads, so assertions check
// the URL as the spec's source of truth rather than trusting component
// state — MemoryRouter keeps its own history, not window.location.
function SearchParamsProbe() {
  const [params] = useSearchParams()
  return <div data-testid="params">{params.toString()}</div>
}

function renderToggle(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <ColorModeToggle />
              <SearchParamsProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ColorModeToggle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to "by type & tag" with no color param, and exactly one radio checked', () => {
    renderToggle()
    const attribute = screen.getByRole('radio', { name: /by type & tag/i })
    const community = screen.getByRole('radio', { name: /by community/i })
    expect(attribute).toBeChecked()
    expect(community).not.toBeChecked()
    expect(screen.getByTestId('params').textContent).toBe('')
  })

  it('clicking "by community" sets ?color=community in the URL and makes exactly one radio checked', async () => {
    const user = userEvent.setup()
    renderToggle()

    await user.click(screen.getByRole('radio', { name: /by community/i }))

    expect(screen.getByTestId('params').textContent).toBe('color=community')
    // A checkbox implementation lets both of these be true at once; native
    // radios sharing one `name` cannot, and this is the assertion that
    // would catch it if they didn't.
    expect(screen.getByRole('radio', { name: /by community/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /by type & tag/i })).not.toBeChecked()
  })

  it('clicking back to "by type & tag" removes the color param entirely (default is omitted, not color=attribute)', async () => {
    const user = userEvent.setup()
    renderToggle('/?color=community')

    await user.click(screen.getByRole('radio', { name: /by type & tag/i }))

    expect(screen.getByTestId('params').textContent).toBe('')
    expect(screen.getByRole('radio', { name: /by type & tag/i })).toBeChecked()
  })

  it('starts on the community radio when ?color=community is in the initial URL — the URL is the source of truth', () => {
    renderToggle('/?color=community')

    expect(screen.getByRole('radio', { name: /by community/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /by type & tag/i })).not.toBeChecked()
  })

  it('renders exactly two mutually exclusive radios and never a checkbox or a third/blend option', () => {
    renderToggle()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('radio', { name: /both|blend/i })).toBeNull()
  })

  it('renders a legend for the active mode only, with a text label on every swatch, and never a teal token', async () => {
    renderToggle()

    // Attribute mode's legend is present...
    expect(screen.getByText(/Type\/tag group 1/)).toBeInTheDocument()
    // ...and community's is not rendered at the same time (never layered).
    expect(screen.queryByText(/Community group/)).toBeNull()

    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: /by community/i }))

    expect(screen.getByText(/Community group 1/)).toBeInTheDocument()
    expect(screen.queryByText(/Type\/tag group/)).toBeNull()

    // Teal (#2B6E6B / #4FA39F) means AI/MCP authorship, never a category —
    // it must not be reachable from any swatch this control renders.
    const swatches = document.querySelectorAll('[style*="background-color"]')
    expect(swatches.length).toBeGreaterThan(0)
    for (const swatch of swatches) {
      const style = (swatch as HTMLElement).style.backgroundColor
      expect(style.toLowerCase()).not.toMatch(/#2b6e6b|#4fa39f|rgb\(43,\s*110,\s*107\)|rgb\(79,\s*163,\s*159\)/)
    }
  })

  it('never renders vermillion (#BA3B1D / #E2683F) as a swatch — that token means human authorship, not a category', async () => {
    renderToggle()
    const vermillion = ['#ba3b1d', '#e2683f']
    const swatches = document.querySelectorAll('[style*="background-color"]')
    expect(swatches.length).toBeGreaterThan(0)
    for (const swatch of swatches) {
      expect((swatch as HTMLElement).style.backgroundColor.toLowerCase()).not.toMatch(
        new RegExp(vermillion.join('|')),
      )
    }
  })

  it('renders different swatch colours in dark mode than in light mode', () => {
    const { container: lightContainer, unmount } = renderToggle()
    const lightColor = (lightContainer.querySelector('[style*="background-color"]') as HTMLElement).style
      .backgroundColor
    unmount()

    document.documentElement.classList.add('dark')
    try {
      const { container: darkContainer } = renderToggle()
      const darkColor = (darkContainer.querySelector('[style*="background-color"]') as HTMLElement).style
        .backgroundColor
      // A theme-blind swatch source would make these identical regardless
      // of `.dark` — this is the assertion that would catch that.
      expect(darkColor).not.toBe(lightColor)
    } finally {
      document.documentElement.classList.remove('dark')
    }
  })

  it('source contains no bg-accent/text-accent — Tailwind\'s accent role is the teal AI token', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/graph/ColorModeToggle.tsx'), 'utf-8')
    expect(source).not.toMatch(/\bbg-accent\b/)
    expect(source).not.toMatch(/\btext-accent\b/)
    expect(source).not.toMatch(/\bhover:bg-accent\b/)
  })

  it('has no accessibility violations', async () => {
    const { container } = renderToggle()
    await expectNoA11yViolations(container)
  })
})
