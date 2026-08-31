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
  /**
   * The expanded/selected community: its nodes get a `--primary` ring so
   * the canvas answers "which one is open" the same way the outline's
   * highlighted row does. `null`/undefined draws no ring. Only meaningful
   * for the aggregated view — in a member view every node shares the one
   * expanded community and a ring on everything is noise, so the caller
   * passes null there.
   */
  highlightCommunity?: number | null
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

// The five approved categorical hues for type/tag colour, one array per
// theme. The dark set is tuned for the #0B0E14 control-room canvas —
// aligned with the collaborator ink tokens (indigo/plum/ochre/forest in
// index.css) and lifted just enough to read over it without going neon.
// The human token (primary blue / the old vermillion) and teal are both
// excluded on purpose: those are AUTHORSHIP tokens (person / AI-MCP
// respectively), not ordinary categories, so a node whose type string
// happens to hash to a given slot must never borrow either of them.
// Exported so ColorModeToggle's legend swatches come from this same
// source of truth instead of a second hardcoded copy.
export const CATEGORY_HUES_LIGHT = ['#5B3B8C', '#3B4C8C', '#7A3B6B', '#8C6D1F', '#3B6B4C']
export const CATEGORY_HUES_DARK = ['#A78BDB', '#8B9DE8', '#D492BD', '#DDB95C', '#7CC796']
/** @deprecated theme-blind alias kept only for consumers that just need the length; prefer `categoryHuesFor`. */
export const CATEGORY_HUES = CATEGORY_HUES_LIGHT

export function categoryHuesFor(isDark: boolean): readonly string[] {
  return isDark ? CATEGORY_HUES_DARK : CATEGORY_HUES_LIGHT
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

// Modulo against a known-fixed-length array is always in range;
// noUncheckedIndexedAccess just can't see that statically.
function hueAt(n: number, isDark: boolean): string {
  const palette = categoryHuesFor(isDark)
  return palette[((n % palette.length) + palette.length) % palette.length]!
}

function isCommunityNode(node: DrawNode): node is DrawCommunityNode {
  return 'lastActivity' in node
}

function categoryColor(node: DrawNode, colorMode: ColorMode, isDark: boolean, mutedColor: string): string {
  if (colorMode === 'community') {
    return hueAt(node.community, isDark)
  }
  // 'attribute' mode: hash by type/tag. Community super-nodes have neither
  // (they aggregate many notes' types) — colouring them by community number
  // here would just silently repaint the community-mode palette under a
  // different label, which is exactly the "toggle does nothing" bug this
  // replaces. They render neutral (muted) instead, honestly showing "no
  // attribute to show" rather than borrowing the other mode's hue.
  if (isCommunityNode(node)) {
    return mutedColor
  }
  const key = node.type ?? node.tags[0] ?? 'untyped'
  return hueAt(hashString(key), isDark)
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

// Edge inks. Aggregated community edges have mixed provenance, so they get
// the neutral border-like grey the spec asks for; member edges keep the
// authorship split — teal (the AI/MCP token, with alpha so dense graphs
// stay calm) for machine-derived structural/semantic edges, foreground-grey
// "ink" for human-authored wikilinks. Colour still means *who*.
const MACHINE_EDGE_DARK = 'rgba(63,184,174,0.55)'
const MACHINE_EDGE_LIGHT = 'rgba(31,119,112,0.55)'
const HUMAN_EDGE_DARK = 'rgba(227,231,239,0.38)'
const HUMAN_EDGE_LIGHT = 'rgba(22,26,34,0.38)'
const AGGREGATED_EDGE_DARK = 'rgba(138,147,166,0.32)'
const AGGREGATED_EDGE_LIGHT = 'rgba(94,102,117,0.32)'

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
  const teal = isDark ? MACHINE_EDGE_DARK : MACHINE_EDGE_LIGHT
  const ink = isDark ? HUMAN_EDGE_DARK : HUMAN_EDGE_LIGHT
  const aggregatedInk = isDark ? AGGREGATED_EDGE_DARK : AGGREGATED_EDGE_LIGHT
  // Matches --muted-foreground per theme: the "no attribute to show" node
  // fill and the colour stale nodes decay toward.
  const muted = isDark ? '#8A93A6' : '#5E6675'
  // --primary per theme: the selected/expanded community's ring.
  const highlight = isDark ? '#5B8DEF' : '#2F6FE0'

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
    strokeBatch(ctx, aggregated, aggregatedInk, (edgeScale * Math.min(6, 0.5 + avgWeight * 0.5)) / transform.k)
  }

  ctx.globalAlpha = 1
  for (const node of nodes) {
    const timestamp = isCommunityNode(node) ? node.lastActivity : node.updatedAt
    const alpha = decayAlpha(timestamp, now)
    ctx.globalAlpha = alpha
    ctx.fillStyle = mixToward(categoryColor(node, colorMode, isDark, muted), muted, 1 - alpha)
    ctx.beginPath()
    ctx.arc(node.x, node.y, node.radius * nodeScale, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // The expanded community's ring, drawn last so it sits over neighbouring
  // fills. One batched stroke for however many nodes carry the community.
  if (opts.highlightCommunity !== null && opts.highlightCommunity !== undefined) {
    const ringOffset = 1.5 / transform.k
    ctx.strokeStyle = highlight
    ctx.lineWidth = 1.5 / transform.k
    ctx.beginPath()
    for (const node of nodes) {
      if (node.community !== opts.highlightCommunity) continue
      const r = node.radius * nodeScale + ringOffset
      ctx.moveTo(node.x + r, node.y)
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
    }
    ctx.stroke()
  }
}
