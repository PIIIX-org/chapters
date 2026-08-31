import { describe, expect, it, vi } from 'vitest'
import { createPanZoom, fitTransform, screenToWorld, worldToScreen, type Transform } from './panzoom.js'

// happy-dom does not implement a PointerEvent constructor; a plain
// MouseEvent with pointerId/clientX/clientY assigned before dispatch still
// fires 'pointerdown'/'pointermove'/etc listeners.
function pointerEvent(type: string, pointerId: number, clientX: number, clientY: number) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true }) as MouseEvent & {
    pointerId: number
  }
  Object.assign(e, { pointerId, clientX, clientY })
  return e
}

// happy-dom's WheelEvent constructor does not carry clientX/clientY through
// from its init dict (only the delta* fields); assign them after construction.
function wheelEvent(deltaY: number, clientX: number, clientY: number) {
  const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }) as WheelEvent & {
    clientX: number
    clientY: number
  }
  Object.assign(e, { clientX, clientY })
  return e
}

describe('createPanZoom', () => {
  it('single pointer pans by the raw screen delta, independent of k', () => {
    const el = document.createElement('div')
    const onChange = vi.fn()
    const { transform } = createPanZoom(el, onChange)

    el.dispatchEvent(pointerEvent('pointerdown', 1, 100, 100))
    el.dispatchEvent(pointerEvent('pointermove', 1, 140, 100))
    el.dispatchEvent(pointerEvent('pointerup', 1, 140, 100))

    expect(transform.x).toBe(40)
    expect(transform.k).toBe(1)
  })

  it('pan delta is not divided by k', () => {
    const el = document.createElement('div')
    const { transform } = createPanZoom(el, vi.fn())
    transform.k = 2

    el.dispatchEvent(pointerEvent('pointerdown', 1, 100, 100))
    el.dispatchEvent(pointerEvent('pointermove', 1, 140, 100))
    el.dispatchEvent(pointerEvent('pointerup', 1, 140, 100))

    expect(transform.x).toBe(40)
  })

  it('pinch scales k by the finger-distance ratio and holds the midpoint fixed in world space', () => {
    const el = document.createElement('div')
    const { transform } = createPanZoom(el, vi.fn())

    const midX = 200
    const midY = 200
    const before = screenToWorld(transform, midX, midY)

    el.dispatchEvent(pointerEvent('pointerdown', 1, 100, 200))
    el.dispatchEvent(pointerEvent('pointerdown', 2, 300, 200))
    // spread 200px -> 300px: move each finger out by 50px
    el.dispatchEvent(pointerEvent('pointermove', 1, 50, 200))
    el.dispatchEvent(pointerEvent('pointermove', 2, 350, 200))

    expect(transform.k).toBeCloseTo(1.5, 9)
    const after = screenToWorld(transform, midX, midY)
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  it('re-anchors the surviving pointer on a two-finger to one-finger handoff', () => {
    const el = document.createElement('div')
    const { transform } = createPanZoom(el, vi.fn())

    el.dispatchEvent(pointerEvent('pointerdown', 1, 100, 200))
    el.dispatchEvent(pointerEvent('pointerdown', 2, 300, 200))
    el.dispatchEvent(pointerEvent('pointerup', 2, 300, 200))

    const xBefore = transform.x
    el.dispatchEvent(pointerEvent('pointermove', 1, 130, 200))

    expect(transform.x).toBeCloseTo(xBefore + 30, 9)
  })

  it('wheel zooms about the cursor, keeping the world point under it fixed', () => {
    const el = document.createElement('div')
    const { transform } = createPanZoom(el, vi.fn())

    const before = screenToWorld(transform, 300, 200)
    el.dispatchEvent(wheelEvent(-100, 300, 200))

    expect(transform.k).toBeGreaterThan(1)
    const after = screenToWorld(transform, 300, 200)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('destroy removes all listeners', () => {
    const el = document.createElement('div')
    const onChange = vi.fn()
    const { destroy } = createPanZoom(el, onChange)

    destroy()
    onChange.mockClear()

    el.dispatchEvent(pointerEvent('pointerdown', 1, 100, 100))
    el.dispatchEvent(pointerEvent('pointermove', 1, 140, 100))

    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('screenToWorld / worldToScreen', () => {
  it('round-trip through a transform', () => {
    const t: Transform = { x: 10, y: -5, k: 2 }
    const world = screenToWorld(t, 50, 50)
    expect(world).toEqual({ x: 20, y: 27.5 })
  })
})

describe('fitTransform', () => {
  it('centres the bounding box of the nodes in the viewport', () => {
    const points = [
      { x: -50, y: 0, radius: 10 },
      { x: 150, y: 80, radius: 10 },
    ]
    const t = fitTransform(points, 800, 600)
    expect(t).not.toBeNull()
    // World centre of the bounds is (50, 40) — it must land at (400, 300).
    const screen = worldToScreen(t!, 50, 40)
    expect(screen.x).toBeCloseTo(400, 6)
    expect(screen.y).toBeCloseTo(300, 6)
  })

  it('caps the scale at maxK so a tiny graph is not blown up to fill the screen', () => {
    const points = [
      { x: 0, y: 0, radius: 2 },
      { x: 4, y: 0, radius: 2 },
    ]
    const t = fitTransform(points, 1000, 1000)
    expect(t?.k).toBe(2)
  })

  it('scales down so the padded bounds fit a small viewport', () => {
    const points = [
      { x: 0, y: 0, radius: 0 },
      { x: 1000, y: 0, radius: 0 },
    ]
    const t = fitTransform(points, 300, 300, { padding: 50 })
    expect(t?.k).toBeCloseTo(0.2, 9) // (300 - 2*50) / 1000
  })

  it('returns null for an empty node set or a zero-size viewport', () => {
    expect(fitTransform([], 800, 600)).toBeNull()
    expect(fitTransform([{ x: 0, y: 0, radius: 1 }], 0, 600)).toBeNull()
    expect(fitTransform([{ x: 0, y: 0, radius: 1 }], 800, 0)).toBeNull()
  })
})

describe('setTransform / zoomBy', () => {
  it('setTransform replaces the transform, clamps k, and emits onChange', () => {
    const el = document.createElement('div')
    const onChange = vi.fn()
    const { transform, setTransform } = createPanZoom(el, onChange)

    setTransform({ x: 12, y: -3, k: 99 })

    expect(transform).toEqual({ x: 12, y: -3, k: 8 }) // k clamped to MAX_K
    expect(onChange).toHaveBeenCalledWith(transform)
  })

  it('zoomBy scales about the element centre, keeping the world point there fixed', () => {
    const el = document.createElement('div')
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    const { transform, zoomBy } = createPanZoom(el, vi.fn())

    const before = screenToWorld(transform, 200, 100)
    zoomBy(1.5)

    expect(transform.k).toBeCloseTo(1.5, 9)
    const after = screenToWorld(transform, 200, 100)
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  it('wheel zoom anchors on element-local coordinates when the element is offset in the viewport', () => {
    const el = document.createElement('div')
    el.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 600, height: 400, right: 700, bottom: 450, x: 100, y: 50, toJSON: () => ({}) }) as DOMRect
    const { transform } = createPanZoom(el, vi.fn())

    // Cursor at client (300, 200) = local (200, 150): that local point must
    // stay fixed. Anchoring on raw client coordinates — the bug inside the
    // grid shell, where the canvas sits 300+ px from the viewport origin —
    // would fix local (300, 200) instead and shift the graph on every zoom.
    const before = screenToWorld(transform, 200, 150)
    el.dispatchEvent(wheelEvent(-100, 300, 200))

    expect(transform.k).toBeGreaterThan(1)
    const after = screenToWorld(transform, 200, 150)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })
})
