// d3-force wiring for the graph layout. This module (and everything it
// imports) must only ever be reachable from GraphCanvas.tsx's own import
// graph — never from anything the shell statically imports — so d3-force
// lands in the lazy graph chunk, not the entry. See client/src/bundle.test.ts.
//
// The simulation is created stopped: GraphCanvas drives it manually, one
// sim.tick() per animation frame (or per settle-batch under reduced motion),
// never via d3-force's own internal rAF timer.
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force'

export interface SimNode extends SimulationNodeDatum {
  id: string
  radius: number
  x: number
  y: number
}

export interface SimEdge<N extends SimNode = SimNode> extends SimulationLinkDatum<N> {
  weight?: number
}

export interface SimulationParams {
  chargeStrength: number
  linkDistance: number
  centerX: number
  centerY: number
  // "Clustering tightness" in the physics-control panel (task 8): how hard
  // forceCenter pulls everything toward (centerX, centerY). 1 matches
  // forceCenter's own built-in default, so introducing this param changes
  // nothing for any caller that doesn't touch it.
  centerStrength: number
}

export const DEFAULT_SIMULATION_PARAMS: SimulationParams = {
  chargeStrength: -120,
  linkDistance: 60,
  centerX: 0,
  centerY: 0,
  centerStrength: 1,
}

export interface GraphSimulation<N extends SimNode> {
  sim: Simulation<N, SimEdge<N>>
  setParams(next: Partial<SimulationParams>): void
}

export function createSimulation<N extends SimNode>(
  nodes: N[],
  edges: SimEdge<N>[],
  params: Partial<SimulationParams> = {},
): GraphSimulation<N> {
  const p = { ...DEFAULT_SIMULATION_PARAMS, ...params }

  const charge = forceManyBody<N>().strength(p.chargeStrength)
  const link = forceLink<N, SimEdge<N>>(edges)
    .id((d) => d.id)
    .distance(p.linkDistance)
  const center = forceCenter<N>(p.centerX, p.centerY).strength(p.centerStrength)
  const collide = forceCollide<N>((d) => d.radius)

  const sim = forceSimulation<N, SimEdge<N>>(nodes)
    .force('charge', charge)
    .force('link', link)
    .force('center', center)
    .force('collide', collide)
    .stop()

  // Re-heat for task 8's physics-control panel. This only sets alpha —
  // it never calls sim.restart(), which would hand ticking back to
  // d3-force's own timer; the caller's rAF loop stays the one driver of
  // sim.tick() and is responsible for noticing alpha rose again and
  // resuming its loop.
  function setParams(next: Partial<SimulationParams>): void {
    if (next.chargeStrength !== undefined) charge.strength(next.chargeStrength)
    if (next.linkDistance !== undefined) link.distance(next.linkDistance)
    if (next.centerX !== undefined) center.x(next.centerX)
    if (next.centerY !== undefined) center.y(next.centerY)
    if (next.centerStrength !== undefined) center.strength(next.centerStrength)
    sim.alpha(1)
  }

  return { sim, setParams }
}
