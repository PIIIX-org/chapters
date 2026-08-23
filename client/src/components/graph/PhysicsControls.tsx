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
// On viewports narrower than 640px (Tailwind's `sm` breakpoint) this is a
// bottom sheet opened from a labelled button; at 640px and up it is always
// an inline panel. Narrow-vs-wide is read once at mount via matchMedia,
// same technique GraphCanvas already uses for prefers-reduced-motion.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { DEFAULT_SIMULATION_PARAMS, type SimulationParams } from './simulation.js'

export const DEFAULT_NODE_SIZE_SCALE = 1
export const DEFAULT_EDGE_WIDTH_SCALE = 1

export interface PhysicsControlsProps {
  initialParams?: SimulationParams
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
        <label htmlFor={spec.id} className="text-sm text-foreground">
          {spec.label}
        </label>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{spec.format(spec.value)}</span>
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
        style={{ accentColor: 'var(--foreground)' }}
      />
    </div>
  )
}

function PanelContent({
  params,
  nodeSizeScale,
  edgeWidthScale,
  ids,
  setPhysics,
  setNodeSize,
  setEdgeWidth,
}: {
  params: SimulationParams
  nodeSizeScale: number
  edgeWidthScale: number
  ids: { charge: string; link: string; tightness: string; nodeSize: string; edgeWidth: string }
  setPhysics: (next: Partial<SimulationParams>) => void
  setNodeSize: (value: number) => void
  setEdgeWidth: (value: number) => void
}) {
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

export function PhysicsControls({ initialParams, onPhysicsChange, onNodeSizeChange, onEdgeWidthChange }: PhysicsControlsProps) {
  const idPrefix = useId()
  const ids = {
    charge: `${idPrefix}-charge`,
    link: `${idPrefix}-link`,
    tightness: `${idPrefix}-tightness`,
    nodeSize: `${idPrefix}-node-size`,
    edgeWidth: `${idPrefix}-edge-width`,
  }

  const [params, setParamsState] = useState<SimulationParams>(initialParams ?? DEFAULT_SIMULATION_PARAMS)
  const [nodeSizeScale, setNodeSizeScaleState] = useState(DEFAULT_NODE_SIZE_SCALE)
  const [edgeWidthScale, setEdgeWidthScaleState] = useState(DEFAULT_EDGE_WIDTH_SCALE)

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

  // Read once at mount, same technique GraphCanvas uses for
  // prefers-reduced-motion: this decides the layout for this mount, not a
  // value that needs to react live to a mid-session resize.
  const [isWide] = useState(() => window.matchMedia('(min-width: 640px)').matches)

  const [open, setOpen] = useState(false)
  const openerRef = useRef<HTMLButtonElement>(null)

  // Bound to `document`, not to the sheet element itself: this project has
  // already shipped an Escape handler bound to a node that focus never
  // actually reaches (ScopePicker), whose test only passed because it
  // fired the event directly on that node. A real Escape keydown lands
  // wherever focus is — which may still be the opener button, a sibling of
  // the sheet, right after a click — so the one binding guaranteed to see
  // it is the document itself.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape') return
      setOpen(false)
      openerRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  const panelProps = { params, nodeSizeScale, edgeWidthScale, ids, setPhysics, setNodeSize, setEdgeWidth }

  if (isWide) {
    return (
      <div className="w-64 rounded-md border border-border bg-card p-3 shadow-sm">
        <h2 className="mb-2 text-sm font-medium text-foreground">Physics</h2>
        <PanelContent {...panelProps} />
      </div>
    )
  }

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-muted"
      >
        Physics controls
      </button>
      {open && (
        <div className="fixed inset-0 z-20 flex items-end justify-center">
          {/* Backdrop: click-to-dismiss, decorative only (the real dismiss
              controls are the Escape handler above and the close button
              below), so it takes no accessible role of its own. */}
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Physics controls"
            className="relative z-10 w-full rounded-t-lg border-t border-border bg-card p-4 shadow-lg animate-in slide-in-from-bottom duration-200 motion-reduce:animate-none"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-foreground">Physics</h2>
              <button
                type="button"
                aria-label="Close physics controls"
                onClick={() => {
                  setOpen(false)
                  openerRef.current?.focus()
                }}
                className="rounded-md px-2 py-1 text-sm hover:bg-muted"
              >
                Close
              </button>
            </div>
            <PanelContent {...panelProps} />
          </div>
        </div>
      )}
    </>
  )
}
