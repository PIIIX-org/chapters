// Linear scan hit-test: a full pass over 2000 nodes measured 0.004ms, ~250x
// cheaper than one frame budget, so a spatial index (quadtree, etc.) here is
// pure ceremony. See the unit 1c task 6 notes.
export interface HitTestPoint {
  x: number
  y: number
}

/**
 * Returns the node whose circle (centre `x`/`y`, radius from `radiusOf`)
 * contains the world-space point `(worldX, worldY)` and is nearest to it, or
 * `null` if the point falls outside every node's radius. Ties for
 * "containing" circles are broken by distance to centre, not by radius or
 * array order.
 */
export function hitTest<N extends HitTestPoint>(
  nodes: N[],
  worldX: number,
  worldY: number,
  radiusOf: (node: N) => number,
): N | null {
  let nearest: N | null = null
  let nearestDist = Infinity

  for (const node of nodes) {
    const dist = Math.hypot(node.x - worldX, node.y - worldY)
    if (dist <= radiusOf(node) && dist < nearestDist) {
      nearest = node
      nearestDist = dist
    }
  }

  return nearest
}
