import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoA11yViolations } from '../../test/axe.js'
import { createSimulation, type SimNode } from './simulation.js'
import { PhysicsControls } from './PhysicsControls.js'

function stubMatchMedia(matchesMinWidth640: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: matchesMinWidth640,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

// A real, tiny simulation — not a mock — so "setParams was called with the
// new link distance AND sim.alpha was re-heated" is checked against the
// actual production wiring in simulation.ts, not a stand-in that could
// silently drift from it.
function makeRealSimulation() {
  const nodes: SimNode[] = [
    { id: 'a', radius: 5, x: 0, y: 0 },
    { id: 'b', radius: 5, x: 10, y: 10 },
  ]
  return createSimulation(nodes, [])
}

function renderControls(overrides: Partial<React.ComponentProps<typeof PhysicsControls>> = {}) {
  const onPhysicsChange = overrides.onPhysicsChange ?? vi.fn()
  const onNodeSizeChange = overrides.onNodeSizeChange ?? vi.fn()
  const onEdgeWidthChange = overrides.onEdgeWidthChange ?? vi.fn()
  return {
    onPhysicsChange,
    onNodeSizeChange,
    onEdgeWidthChange,
    ...render(
      <PhysicsControls
        onPhysicsChange={onPhysicsChange}
        onNodeSizeChange={onNodeSizeChange}
        onEdgeWidthChange={onEdgeWidthChange}
      />,
    ),
  }
}

describe('PhysicsControls', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('the link-distance slider calls setParams with the new distance and actually re-heats the real simulation', async () => {
    stubMatchMedia(true)
    const { sim, setParams } = makeRealSimulation()
    const setParamsSpy = vi.fn(setParams)
    const alphaSpy = vi.spyOn(sim, 'alpha')
    const user = userEvent.setup()
    renderControls({ onPhysicsChange: setParamsSpy })

    const slider = screen.getByRole('slider', { name: /link distance/i })
    // Click-to-focus, per the task's own fallback: tab order is not what
    // this test is about, and clicking a range input focuses it without
    // changing its value under happy-dom.
    await user.click(slider)
    await user.keyboard('{ArrowRight}')

    // A broken implementation that never wires ArrowRight to a value
    // change (relying on native range-key stepping, which the test
    // environment does not implement) would never call this at all.
    expect(setParamsSpy).toHaveBeenCalledWith({ linkDistance: 70 })
    // Proves the real setParams path actually ran (not just a same-shaped
    // mock): simulation.ts's setParams raises alpha to 1 on every call.
    expect(alphaSpy).toHaveBeenCalledWith(1)
  })

  it('the node-size slider redraws (DRAW-only) and never touches physics or re-heats the simulation', async () => {
    stubMatchMedia(true)
    const { sim, setParams } = makeRealSimulation()
    const setParamsSpy = vi.fn(setParams)
    const alphaSpy = vi.spyOn(sim, 'alpha')
    const onNodeSizeChange = vi.fn()
    const user = userEvent.setup()
    renderControls({ onPhysicsChange: setParamsSpy, onNodeSizeChange })

    const slider = screen.getByRole('slider', { name: /node size/i })
    await user.click(slider)
    await user.keyboard('{ArrowRight}')

    // A redraw happened...
    expect(onNodeSizeChange).toHaveBeenCalledWith(1.1)
    // ...but a blanket "re-heat on every control" bug — which would also
    // pass the link-distance test above — is caught here: neither the
    // physics callback nor the simulation's alpha was ever touched.
    expect(setParamsSpy).not.toHaveBeenCalled()
    expect(alphaSpy).not.toHaveBeenCalled()
  })

  it('the edge-width slider also redraws without touching physics', async () => {
    stubMatchMedia(true)
    const onPhysicsChange = vi.fn()
    const onEdgeWidthChange = vi.fn()
    const user = userEvent.setup()
    renderControls({ onPhysicsChange, onEdgeWidthChange })

    const slider = screen.getByRole('slider', { name: /edge width/i })
    await user.click(slider)
    await user.keyboard('{ArrowRight}')

    expect(onEdgeWidthChange).toHaveBeenCalledWith(1.1)
    expect(onPhysicsChange).not.toHaveBeenCalled()
  })

  it('on viewports narrower than 640px, the panel is a bottom sheet: absent until opened, closed by Escape wherever focus actually is, with focus returned to the opener', async () => {
    stubMatchMedia(false)
    const user = userEvent.setup()
    renderControls()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const opener = screen.getByRole('button', { name: /physics controls/i })
    await user.click(opener)

    expect(screen.getByRole('dialog', { name: /physics controls/i })).toBeInTheDocument()

    // Escape is driven from wherever a real click actually leaves focus —
    // clicking the opener does not move focus into the sheet — and is
    // never dispatched on the panel element directly. An Escape listener
    // bound only to the panel (this project's ScopePicker bug, before its
    // fix) would leave the sheet open here.
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(opener)
  })

  it('the close button also closes the sheet and returns focus to the opener', async () => {
    stubMatchMedia(false)
    const user = userEvent.setup()
    renderControls()

    const opener = screen.getByRole('button', { name: /physics controls/i })
    await user.click(opener)
    await user.click(screen.getByRole('button', { name: /close physics controls/i }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(opener)
  })

  it('at 640px and up, the panel is always inline — no open button, no dialog', () => {
    stubMatchMedia(true)
    renderControls()

    expect(screen.queryByRole('button', { name: /physics controls/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('slider', { name: /link distance/i })).toBeInTheDocument()
  })

  it('every one of the five sliders has a real accessible name from an associated label', () => {
    stubMatchMedia(true)
    renderControls()

    expect(screen.getByRole('slider', { name: /force strength/i })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: /link distance/i })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: /clustering tightness/i })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: /node size/i })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: /edge width/i })).toBeInTheDocument()
    expect(screen.getAllByRole('slider')).toHaveLength(5)
  })

  it('shows a live value readout next to each slider', () => {
    stubMatchMedia(true)
    renderControls()

    expect(screen.getByText('-120')).toBeInTheDocument() // force strength
    expect(screen.getByText('60')).toBeInTheDocument() // link distance
    expect(screen.getByText('1.0')).toBeInTheDocument() // clustering tightness
    expect(screen.getAllByText('1.0×').length).toBeGreaterThan(0) // node size / edge width
  })

  it('source contains no bg-accent/text-accent — Tailwind\'s accent role is the teal AI token, not a UI hover/active state', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/graph/PhysicsControls.tsx'), 'utf-8')
    expect(source).not.toMatch(/\bbg-accent\b/)
    expect(source).not.toMatch(/\btext-accent\b/)
    expect(source).not.toMatch(/\bhover:bg-accent\b/)
  })

  it('has no accessibility violations in the inline layout', async () => {
    stubMatchMedia(true)
    const { container } = renderControls()
    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations in the open bottom-sheet layout', async () => {
    stubMatchMedia(false)
    const user = userEvent.setup()
    const { container } = renderControls()
    await user.click(screen.getByRole('button', { name: /physics controls/i }))
    await expectNoA11yViolations(container)
  })
})
