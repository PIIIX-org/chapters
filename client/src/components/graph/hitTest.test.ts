import { describe, expect, it } from 'vitest'
import { hitTest } from './hitTest.js'

interface Node {
  id: string
  x: number
  y: number
  radius: number
}

const radiusOf = (n: Node) => n.radius

describe('hitTest', () => {
  it('returns null when the point falls outside every node radius', () => {
    const nodes: Node[] = [
      { id: 'a', x: 0, y: 0, radius: 5 },
      { id: 'b', x: 100, y: 100, radius: 5 },
    ]

    expect(hitTest(nodes, 50, 50, radiusOf)).toBeNull()
  })

  it('returns the nearer centre when the point falls inside two overlapping radii', () => {
    const near: Node = { id: 'near', x: 10, y: 0, radius: 20 }
    const far: Node = { id: 'far', x: -15, y: 0, radius: 20 }
    // point at x=0 is inside both circles (|10-0|=10 < 20, |-15-0|=15 < 20)
    // but strictly closer to `near`'s centre.
    const nodes: Node[] = [far, near]

    expect(hitTest(nodes, 0, 0, radiusOf)).toBe(near)
  })

  it('picks the nearer centre even when the nearer node has the smaller radius', () => {
    const smallButCloser: Node = { id: 'small', x: 2, y: 0, radius: 3 }
    const bigButFarther: Node = { id: 'big', x: -8, y: 0, radius: 30 }
    const nodes: Node[] = [bigButFarther, smallButCloser]

    expect(hitTest(nodes, 0, 0, radiusOf)).toBe(smallButCloser)
  })

  it('returns a node exactly on its radius boundary (inclusive)', () => {
    const node: Node = { id: 'edge', x: 0, y: 0, radius: 10 }
    expect(hitTest([node], 10, 0, radiusOf)).toBe(node)
  })
})
