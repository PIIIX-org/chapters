import { describe, expect, it, vi } from 'vitest'
import { createPanZoom, screenToWorld, type Transform } from './panzoom.js'

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
