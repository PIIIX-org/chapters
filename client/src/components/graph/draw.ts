// Pure canvas draw module. happy-dom's canvas.getContext('2d') returns null,
// so nothing here can live inside a component that mounts a real canvas —
// GraphCanvas.tsx owns the canvas element, the rAF loop, and
// devicePixelRatio; this module only ever receives a 2D context (or, in
// tests, a recording fake) and a plain-data description of what to draw.
import type { Transform } from './panzoom.js'

export interface DrawPoint {
  x: number
  y: number
}

// Member nodes (a note or code file) decay from `updatedAt`. Community
// super-nodes decay from `lastActivity` instead — they have no single
// author timestamp of their own. The two are told apart structurally (does
// `lastActivity` exist on the object at all), matching how the API already
// shapes GraphNode vs CommunityNode, without importing those types here and
// coupling this pure module to the fetch layer.
export interface DrawMemberNode extends DrawPoint {
  id: string
  type: string | null
  tags: string[]
  updatedAt: string | null
  community: number
  radius: number
}

export interface DrawCommunityNode extends DrawPoint {
  id: string
  community: number
  lastActivity: string | null
  radius: number
}

export type DrawNode = DrawMemberNode | DrawCommunityNode

// Machine-derived edges (structural/semantic) carry `kind` and are batched
// teal. Human-authored (extracted/wikilink) edges carry `kind: 'extracted'`
// and are batched ink. Aggregated community edges carry `weight` and no
// `kind` at all (their provenance is mixed) — that absence is load-bearing,
// not accidental, so it is not defaulted or backfilled here.
export interface DrawMemberEdge {
  source: DrawPoint
  target: DrawPoint
  kind: 'extracted' | 'structural' | 'semantic'
}

export interface DrawAggregatedEdge {
  source: DrawPoint
  target: DrawPoint
  weight: number
}

export type DrawEdge = DrawMemberEdge | DrawAggregatedEdge

export type ColorMode = 'attribute' | 'community'

export interface DrawGraphOptions {
  nodes: DrawNode[]
  edges: DrawEdge[]
  transform: Transform
  colorMode: ColorMode
  isDark: boolean
  now: number
  // Task 8's node-size / edge-width sliders. DRAW-only: these scale what
  // gets painted, never what forceCollide (simulation.ts) uses for
  // physics, which stays each node's own unscaled `radius`. Optional and
  // defaulted to 1 so every existing caller/test is unaffected.
  nodeSizeScale?: number
  edgeWidthScale?: number
}

const DAY_MS = 86_400_000
const FRESH_DAYS = 7
const STALE_DAYS = 180
const FLOOR_ALPHA = 0.25

/**
 * 1.0 for anything under 7 days old, falling monotonically to a floor of
 * 0.25 at 180 days and flat beyond. A `null` timestamp (code nodes have no
 * `updatedAt`) is absence of data, not evidence of staleness, so it reads
 * as fresh — same for an unparseable timestamp.
 */
export function decayAlpha(timestamp: string | null, now: number): number {
  if (timestamp === null) return 1
  const ts = Date.parse(timestamp)
  if (Number.isNaN(ts)) return 1
  const ageDays = (now - ts) / DAY_MS
  if (ageDays <= FRESH_DAYS) return 1
  if (ageDays >= STALE_DAYS) return FLOOR_ALPHA
  const t = (ageDays - FRESH_DAYS) / (STALE_DAYS - FRESH_DAYS)
  return 1 - t * (1 - FLOOR_ALPHA)
}

// The five approved ink hues for category colour. Teal is deliberately
// absent — it means AI/MCP authorship, never a category, and must never be
// reachable from this palette. Exported so ColorModeToggle's legend swatches
// come from this single source of truth instead of a second hardcoded copy.
export const CATEGORY_HUES = ['#BA3B1D', '#3B4C8C', '#7A3B6B', '#8C6D1F', '#3B6B4C']

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

// Modulo against a known-fixed-length array is always in range;
// noUncheckedIndexedAccess just can't see that statically.
function hueAt(n: number): string {
  return CATEGORY_HUES[((n % CATEGORY_HUES.length) + CATEGORY_HUES.length) % CATEGORY_HUES.length]!
}

function isCommunityNode(node: DrawNode): node is DrawCommunityNode {
  return 'lastActivity' in node
}

function categoryColor(node: DrawNode, colorMode: ColorMode): string {
  if (colorMode === 'community') {
    return hueAt(node.community)
  }
  // 'attribute' mode: hash by type/tag. Community super-nodes have neither
  // (they aggregate many notes' types), so they fall back to community
  // number rather than inventing a type they don't have.
  if (isCommunityNode(node)) {
    return hueAt(node.community)
  }
  const key = node.type ?? node.tags[0] ?? 'untyped'
  return hueAt(hashString(key))
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

function mixToward(hex: string, towardHex: string, fraction: number): string {
  const a = hexToRgb(hex)
  const b = hexToRgb(towardHex)
  const [r, g, bl] = a.map((v, i) => Math.round(v + (b[i]! - v) * fraction))
  return `rgb(${r},${g},${bl})`
}

function strokeBatch(ctx: CanvasRenderingContext2D, edges: DrawEdge[], color: string, lineWidth: number): void {
  if (edges.length === 0) return
  ctx.beginPath()
  for (const edge of edges) {
    ctx.moveTo(edge.source.x, edge.source.y)
    ctx.lineTo(edge.target.x, edge.target.y)
  }
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.stroke()
}

/**
 * Draws the whole graph in exactly three possible stroke() calls (one per
 * edge provenance batch, skipped if that batch is empty) plus one fill per
 * node. At the backend's real density (~57 edges/node, ~2000-node expanded
 * community => ~57k edges) a per-edge beginPath/stroke loop is a 40x-cost
 * regression; batching by provenance is what keeps this at ~1.4ms/frame
 * instead of tens of thousands of draw calls, and it is also exactly the
 * dual-accent authorship rule: colour means *who* touched the edge.
 */
export function drawGraph(ctx: CanvasRenderingContext2D, opts: DrawGraphOptions): void {
  const { nodes, edges, transform, colorMode, isDark, now } = opts
  const nodeScale = opts.nodeSizeScale ?? 1
  const edgeScale = opts.edgeWidthScale ?? 1
  const ink = isDark ? '#EDE8DD' : '#1C1A16'
  const teal = isDark ? '#4FA39F' : '#2B6E6B'
  const muted = isDark ? '#A39C8C' : '#6B6558'

  // Clear the full backing store in device space, then apply the pan/zoom
  // transform once for everything drawn after it. The caller has already
  // folded devicePixelRatio into `transform` (or into canvas sizing) — this
  // module never reads devicePixelRatio itself.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas?.width ?? 0, ctx.canvas?.height ?? 0)
  ctx.setTransform(transform.k, 0, 0, transform.k, transform.x, transform.y)
  ctx.globalAlpha = 1

  const machine = edges.filter((e): e is DrawMemberEdge => 'kind' in e && e.kind !== 'extracted')
  const human = edges.filter((e): e is DrawMemberEdge => 'kind' in e && e.kind === 'extracted')
  const aggregated = edges.filter((e): e is DrawAggregatedEdge => !('kind' in e))

  strokeBatch(ctx, machine, teal, (edgeScale * 1) / transform.k)
  strokeBatch(ctx, human, ink, (edgeScale * 1) / transform.k)
  if (aggregated.length > 0) {
    const avgWeight = aggregated.reduce((sum, e) => sum + e.weight, 0) / aggregated.length
    // ponytail: a single stroke() call can only carry one lineWidth, so a
    // per-batch average stands in for "scaled from weight" rather than a
    // true per-edge width — splitting into weight buckets would trade the
    // one-call guarantee for a handful of calls if this ever needs to be
    // truer to individual weights.
    strokeBatch(ctx, aggregated, muted, (edgeScale * Math.min(6, 0.5 + avgWeight * 0.5)) / transform.k)
  }

  ctx.globalAlpha = 1
  for (const node of nodes) {
    const timestamp = isCommunityNode(node) ? node.lastActivity : node.updatedAt
    const alpha = decayAlpha(timestamp, now)
    ctx.globalAlpha = alpha
    ctx.fillStyle = mixToward(categoryColor(node, colorMode), muted, 1 - alpha)
    ctx.beginPath()
    ctx.arc(node.x, node.y, node.radius * nodeScale, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}
