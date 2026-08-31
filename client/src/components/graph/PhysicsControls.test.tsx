import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoA11yViolations } from '../../test/axe.js'
import { createSimulation, type SimNode } from './simulation.js'
import { PhysicsControls } from './PhysicsControls.js'

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

  it('renders inline, always — the command redesign hosts it in the inspector, so there is no open button and no dialog', () => {
    renderControls()

    expect(screen.queryByRole('button', { name: /physics controls/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('slider', { name: /link distance/i })).toBeInTheDocument()
  })

  it('every one of the five sliders has a real accessible name from an associated label', () => {
    renderControls()

    expect(screen.getByRole('slider', { name: /force strength/i })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: /link distance/i })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: /clustering tightness/i })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: /node size/i })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: /edge width/i })).toBeInTheDocument()
    expect(screen.getAllByRole('slider')).toHaveLength(5)
  })

  it('shows a live value readout next to each slider', () => {
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
    const { container } = renderControls()
    await expectNoA11yViolations(container)
  })

})
