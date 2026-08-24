import { describe, expect, it } from 'vitest'
import { positionFor, radiusFor } from './constellation.js'

describe('radiusFor', () => {
  it('is monotonic: a bigger mass never yields a smaller radius', () => {
    const masses = [0, 1, 5, 50, 500, 10_000]
    const maxMass = 10_000
    const radii = masses.map((m) => radiusFor(m, maxMass))
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThanOrEqual(radii[i - 1]!)
    }
  })

  it('gives equal masses equal radii', () => {
    expect(radiusFor(42, 100)).toBe(radiusFor(42, 100))
  })

  it('clamps at the low end for mass 0', () => {
    expect(radiusFor(0, 10_000)).toBe(6)
  })

  it('clamps at the high end for an absurdly large mass', () => {
    // A bug that used a linear scale (mass / maxMass * MAX_RADIUS with no
    // ceiling, or that let mass exceed maxMass push past 100%) would let
    // this blow past the clamp.
    expect(radiusFor(1_000_000, 100)).toBe(28)
    expect(radiusFor(100, 100)).toBe(28)
  })

  it('never lets one person"s circle fill the canvas: a linear scale would put mass=100 of maxMass=10000 near the max, sqrt keeps it modest', () => {
    // 100/10000 = 1% of mass. A linear scale gives ~1% of the radius range
    // (barely above MIN_RADIUS). A sqrt scale gives sqrt(0.01) = 10% of the
    // range — still clearly smaller than the top of the range.
    const r = radiusFor(100, 10_000)
    expect(r).toBeGreaterThan(6)
    expect(r).toBeLessThan(6 + (28 - 6) * 0.5)
  })
})

describe('positionFor', () => {
  it('returns distinct coordinates for every index when count > 1', () => {
    const count = 7
    const points = Array.from({ length: count }, (_, i) => positionFor(i, count))
    const keys = new Set(points.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`))
    expect(keys.size).toBe(count)
  })

  it('is deterministic across calls', () => {
    expect(positionFor(2, 7)).toEqual(positionFor(2, 7))
    expect(positionFor(0, 1)).toEqual(positionFor(0, 1))
  })

  it('does not stack everyone at one point', () => {
    const count = 5
    const points = Array.from({ length: count }, (_, i) => positionFor(i, count))
    const first = points[0]!
    const allSame = points.every((p) => p.x === first.x && p.y === first.y)
    expect(allSame).toBe(false)
  })
})
