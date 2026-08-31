// Task 8: physics are exposed, not hidden defaults. Five native
// <input type="range"> sliders, each with a real <label> and a live value
// readout. Force strength / link distance / clustering tightness are
// physics (routed through simulation.ts's setParams, which re-heats the
// simulation); node size / edge width are DRAW-only cosmetic scales
// (routed to GraphCanvas's paint-only refs) and must never re-heat —
// re-running layout because someone nudged a cosmetic slider throws away a
// settled graph and costs real frame time at scale (see the unit's risk
// notes).
//
// Since the command redesign this panel always renders inline — it lives in
// the inspector's Physics tab, and below 1024px the inspector itself is the
// shell's drawer, so the old self-managed bottom sheet is gone. Radix
// unmounts an inactive tab, so the `initial*` props exist for the parent to
// re-seed each mount with wherever the user last left the sliders; without
// them a tab switch would silently snap the display back to defaults while
// the simulation kept the user's values.
import { useId, useState, type KeyboardEvent } from 'react'
import { DEFAULT_SIMULATION_PARAMS, type SimulationParams } from './simulation.js'

export const DEFAULT_NODE_SIZE_SCALE = 1
export const DEFAULT_EDGE_WIDTH_SCALE = 1

export interface PhysicsControlsProps {
  initialParams?: SimulationParams
  initialNodeSizeScale?: number
  initialEdgeWidthScale?: number
  onPhysicsChange: (next: Partial<SimulationParams>) => void
  onNodeSizeChange: (value: number) => void
  onEdgeWidthChange: (value: number) => void
}

interface SliderSpec {
  id: string
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
  format: (value: number) => string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// Native <input type="range"> keyboard stepping is browser chrome, not DOM
// logic — it isn't implemented by the test environment (happy-dom), and
// @testing-library/user-event only special-cases arrow keys for radio
// inputs, so a keyboard user pressing ArrowRight on a bare range input
// would do nothing under test even though a real browser handles it. This
// owns stepping itself (with preventDefault, so a real browser's own
// native stepping never double-applies on top of it) rather than relying
// on a browser behaviour the test — and therefore any keyboard user in an
// environment without it — can't observe.
function stepFromKey(e: KeyboardEvent<HTMLInputElement>, spec: Pick<SliderSpec, 'min' | 'max' | 'step' | 'value'>): number | null {
  const { min, max, step, value } = spec
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(value + step, min, max)
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(value - step, min, max)
    case 'PageUp':
      return clamp(value + step * 10, min, max)
    case 'PageDown':
      return clamp(value - step * 10, min, max)
    case 'Home':
      return min
    case 'End':
      return max
    default:
      return null
  }
}

function Slider(spec: SliderSpec) {
  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const next = stepFromKey(e, spec)
    if (next === null || next === spec.value) return
    e.preventDefault()
    spec.onChange(next)
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={spec.id} className="text-[13px] text-foreground">
          {spec.label}
        </label>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{spec.format(spec.value)}</span>
      </div>
      <input
        id={spec.id}
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={spec.value}
        onChange={(e) => spec.onChange(Number(e.currentTarget.value))}
        onKeyDown={handleKeyDown}
        className="w-full"
        style={{ accentColor: 'var(--muted-foreground)' }}
      />
    </div>
  )
}

export function PhysicsControls({
  initialParams,
  initialNodeSizeScale,
  initialEdgeWidthScale,
  onPhysicsChange,
  onNodeSizeChange,
  onEdgeWidthChange,
}: PhysicsControlsProps) {
  const idPrefix = useId()
  const ids = {
    charge: `${idPrefix}-charge`,
    link: `${idPrefix}-link`,
    tightness: `${idPrefix}-tightness`,
    nodeSize: `${idPrefix}-node-size`,
    edgeWidth: `${idPrefix}-edge-width`,
  }

  const [params, setParamsState] = useState<SimulationParams>(initialParams ?? DEFAULT_SIMULATION_PARAMS)
  const [nodeSizeScale, setNodeSizeScaleState] = useState(initialNodeSizeScale ?? DEFAULT_NODE_SIZE_SCALE)
  const [edgeWidthScale, setEdgeWidthScaleState] = useState(initialEdgeWidthScale ?? DEFAULT_EDGE_WIDTH_SCALE)

  function setPhysics(next: Partial<SimulationParams>) {
    setParamsState((prev) => ({ ...prev, ...next }))
    onPhysicsChange(next)
  }
  function setNodeSize(value: number) {
    setNodeSizeScaleState(value)
    onNodeSizeChange(value)
  }
  function setEdgeWidth(value: number) {
    setEdgeWidthScaleState(value)
    onEdgeWidthChange(value)
  }

  return (
    <div className="flex flex-col gap-3">
      <Slider
        id={ids.charge}
        label="Force strength"
        min={-400}
        max={-10}
        step={10}
        value={params.chargeStrength}
        onChange={(v) => setPhysics({ chargeStrength: v })}
        format={(v) => String(v)}
      />
      <Slider
        id={ids.link}
        label="Link distance"
        min={10}
        max={300}
        step={10}
        value={params.linkDistance}
        onChange={(v) => setPhysics({ linkDistance: v })}
        format={(v) => String(v)}
      />
      <Slider
        id={ids.tightness}
        label="Clustering tightness"
        min={0}
        max={2}
        step={0.1}
        value={params.centerStrength}
        onChange={(v) => setPhysics({ centerStrength: v })}
        format={(v) => v.toFixed(1)}
      />
      <Slider
        id={ids.nodeSize}
        label="Node size"
        min={0.5}
        max={2}
        step={0.1}
        value={nodeSizeScale}
        onChange={setNodeSize}
        format={(v) => `${v.toFixed(1)}×`}
      />
      <Slider
        id={ids.edgeWidth}
        label="Edge width"
        min={0.5}
        max={3}
        step={0.1}
        value={edgeWidthScale}
        onChange={setEdgeWidth}
        format={(v) => `${v.toFixed(1)}×`}
      />
    </div>
  )
}
