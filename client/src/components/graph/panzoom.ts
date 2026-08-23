// Hand-rolled Pointer Events pan/pinch/wheel, in place of d3-zoom (+13.9 KB
// gzipped for behaviour this file covers in ~55 lines). See
// docs/superpowers/specs/2026-08-22-remaining-ui-design.md and the unit 1c
// task notes for the renderer decision.
//
// Convention: screen = world * k + offset, i.e. transform.{x,y} is the
// screen-space offset and transform.k is the scale.

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

interface PointerState {
  anchor: { x: number; y: number } // world position, fixed for the life of the gesture
  screen: { x: number; y: number } // latest known screen position
}

export function createPanZoom(
  el: HTMLElement,
  onChange: (t: Transform) => void,
  initial: Transform = { x: 0, y: 0, k: 1 },
): { transform: Transform; destroy(): void } {
  const transform: Transform = { ...initial }
  const pointers = new Map<number, PointerState>()

  el.style.touchAction = 'none'

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
    const screen = { x: e.clientX, y: e.clientY }
    pointers.set(e.pointerId, { anchor: screenToWorld(transform, screen.x, screen.y), screen })
  }

  function onPointerMove(e: PointerEvent) {
    const state = pointers.get(e.pointerId)
    if (!state) return
    state.screen = { x: e.clientX, y: e.clientY }
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
    zoomAt(e.clientX, e.clientY, transform.k * Math.pow(2, -e.deltaY / 400))
    emit()
  }

  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('pointercancel', onPointerUp)
  el.addEventListener('wheel', onWheel, { passive: false })

  return {
    transform,
    destroy() {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
      el.removeEventListener('wheel', onWheel)
    },
  }
}
