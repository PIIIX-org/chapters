// Hand-rolled Pointer Events pan/pinch/wheel, in place of d3-zoom (+13.9 KB
// gzipped for behaviour this file covers in ~55 lines). See
// docs/superpowers/specs/2026-08-22-remaining-ui-design.md and the unit 1c
// task notes for the renderer decision.
//
// Convention: screen = world * k + offset, i.e. transform.{x,y} is the
// element-local screen-space offset and transform.k is the scale. Every
// incoming pointer/wheel coordinate is converted from viewport client
// coordinates to element-local ones first — inside the grid shell the canvas
// sits 300+ px from the viewport origin, and anchoring zoom on raw clientX/Y
// would zoom about a point far off the cursor.

export interface Transform {
  x: number
  y: number
  k: number
}

const MIN_K = 0.1
const MAX_K = 8

export function screenToWorld(t: Transform, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - t.x) / t.k, y: (sy - t.y) / t.k }
}

export function worldToScreen(t: Transform, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * t.k + t.x, y: wy * t.k + t.y }
}

function clampK(k: number): number {
  return Math.min(MAX_K, Math.max(MIN_K, k))
}

export interface FitOptions {
  /** CSS px kept clear around the fitted bounds. */
  padding?: number
  /** Never zoom in past this — a two-node graph must not fill the screen. */
  maxK?: number
}

/**
 * The transform that centres the nodes' bounding box (node centres ± radius)
 * in a `width`×`height` viewport. Pure and side-effect free so GraphCanvas's
 * first paint, its "fit" button and the settle-follow camera all share one
 * definition of "centred". Returns null when there is nothing to fit or the
 * viewport has no size yet (first render before layout) — callers keep their
 * current transform in that case rather than snapping to a garbage one.
 */
export function fitTransform(
  points: readonly { x: number; y: number; radius: number }[],
  width: number,
  height: number,
  { padding = 40, maxK = 2 }: FitOptions = {},
): Transform | null {
  if (points.length === 0 || width <= 0 || height <= 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x - p.radius)
    minY = Math.min(minY, p.y - p.radius)
    maxX = Math.max(maxX, p.x + p.radius)
    maxY = Math.max(maxY, p.y + p.radius)
  }
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const k = clampK(
    Math.min(maxK, Math.max(0, width - padding * 2) / spanX, Math.max(0, height - padding * 2) / spanY),
  )
  return {
    k,
    x: width / 2 - ((minX + maxX) / 2) * k,
    y: height / 2 - ((minY + maxY) / 2) * k,
  }
}

interface PointerState {
  anchor: { x: number; y: number } // world position, fixed for the life of the gesture
  screen: { x: number; y: number } // latest known element-local position
}

export interface PanZoom {
  transform: Transform
  /** Replace the transform wholesale (fit/centre); clamps k and emits onChange. */
  setTransform(next: Transform): void
  /** Zoom by a factor about the element's centre (the +/− buttons); emits onChange. */
  zoomBy(factor: number): void
  destroy(): void
}

export function createPanZoom(
  el: HTMLElement,
  onChange: (t: Transform) => void,
  initial: Transform = { x: 0, y: 0, k: 1 },
): PanZoom {
  const transform: Transform = { ...initial }
  const pointers = new Map<number, PointerState>()

  el.style.touchAction = 'none'

  function localPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = el.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  function emit() {
    onChange(transform)
  }

  function zoomAt(sx: number, sy: number, nextK: number) {
    const k = clampK(nextK)
    // Keep the world point under (sx, sy) fixed on screen.
    const world = screenToWorld(transform, sx, sy)
    transform.k = k
    transform.x = sx - world.x * k
    transform.y = sy - world.y * k
  }

  // Rebuild the transform from each active pointer's fixed world anchor and
  // its latest screen position. This is recomputed from scratch (rather than
  // incrementally from the previous frame) so a two-finger pinch gives the
  // same result no matter which finger's pointermove arrives first — an
  // incremental per-event update is path-dependent and drifts.
  function recomputeFromPointers() {
    const states = [...pointers.values()]
    if (states.length === 1) {
      const [state] = states as [PointerState]
      const { anchor, screen } = state
      transform.x = screen.x - transform.k * anchor.x
      transform.y = screen.y - transform.k * anchor.y
      return
    }
    if (states.length === 2) {
      const [a, b] = states as [PointerState, PointerState]
      const worldDist = Math.hypot(b.anchor.x - a.anchor.x, b.anchor.y - a.anchor.y)
      const screenDist = Math.hypot(b.screen.x - a.screen.x, b.screen.y - a.screen.y)
      const k = worldDist > 0 ? clampK(screenDist / worldDist) : transform.k
      const worldMidX = (a.anchor.x + b.anchor.x) / 2
      const worldMidY = (a.anchor.y + b.anchor.y) / 2
      const screenMidX = (a.screen.x + b.screen.x) / 2
      const screenMidY = (a.screen.y + b.screen.y) / 2
      transform.k = k
      transform.x = screenMidX - k * worldMidX
      transform.y = screenMidY - k * worldMidY
    }
  }

  function onPointerDown(e: PointerEvent) {
    el.setPointerCapture?.(e.pointerId)
    const screen = localPoint(e.clientX, e.clientY)
    pointers.set(e.pointerId, { anchor: screenToWorld(transform, screen.x, screen.y), screen })
  }

  function onPointerMove(e: PointerEvent) {
    const state = pointers.get(e.pointerId)
    if (!state) return
    state.screen = localPoint(e.clientX, e.clientY)
    recomputeFromPointers()
    emit()
  }

  function onPointerUp(e: PointerEvent) {
    pointers.delete(e.pointerId)
    // Re-anchor every surviving pointer against the transform as it stands
    // now, using its last-known screen position, so a two-finger ->
    // one-finger handoff doesn't jump on the next move.
    for (const state of pointers.values()) {
      state.anchor = screenToWorld(transform, state.screen.x, state.screen.y)
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault()
    const p = localPoint(e.clientX, e.clientY)
    zoomAt(p.x, p.y, transform.k * Math.pow(2, -e.deltaY / 400))
    emit()
  }

  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('pointercancel', onPointerUp)
  el.addEventListener('wheel', onWheel, { passive: false })

  return {
    transform,
    setTransform(next: Transform) {
      transform.x = next.x
      transform.y = next.y
      transform.k = clampK(next.k)
      emit()
    },
    zoomBy(factor: number) {
      const rect = el.getBoundingClientRect()
      zoomAt(rect.width / 2, rect.height / 2, transform.k * factor)
      emit()
    },
    destroy() {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
      el.removeEventListener('wheel', onWheel)
    },
  }
}
