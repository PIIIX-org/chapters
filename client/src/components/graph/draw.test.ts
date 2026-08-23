import { describe, expect, it, vi } from 'vitest'
import { decayAlpha, drawGraph, type DrawEdge, type DrawNode } from './draw.js'

interface RecordedCall {
  op: 'stroke' | 'fill'
  strokeStyle?: unknown
  fillStyle?: unknown
  globalAlpha?: number
  lineWidth?: number
}

// A recording fake: happy-dom's canvas.getContext('2d') returns null, so
// draw.ts is exercised through a plain object standing in for
// CanvasRenderingContext2D. Style properties are read at the moment
// stroke()/fill() is actually invoked (matching how a real context applies
// state at draw time), not at assignment time, so a call snapshot reflects
// exactly what would have hit the screen.
function createFakeCtx() {
  const calls: RecordedCall[] = []
  const ctx = {
    canvas: { width: 800, height: 600 },
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    stroke: vi.fn(function (this: typeof ctx) {
      calls.push({ op: 'stroke', strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha, lineWidth: this.lineWidth })
    }),
    fill: vi.fn(function (this: typeof ctx) {
      calls.push({ op: 'fill', fillStyle: this.fillStyle, globalAlpha: this.globalAlpha })
    }),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

const IDENTITY = { x: 0, y: 0, k: 1 }
const NOW = Date.UTC(2026, 7, 23)

function point(x: number, y: number) {
  return { x, y }
}

describe('drawGraph — edge batching', () => {
  it('batches every machine and human edge into exactly two stroke() calls, all edges still drawn', () => {
    const { ctx, calls } = createFakeCtx()
    const edges: DrawEdge[] = [
      { source: point(0, 0), target: point(1, 1), kind: 'semantic' },
      { source: point(0, 0), target: point(2, 2), kind: 'semantic' },
      { source: point(0, 0), target: point(3, 3), kind: 'semantic' },
      { source: point(0, 0), target: point(4, 4), kind: 'structural' },
      { source: point(0, 0), target: point(5, 5), kind: 'extracted' },
      { source: point(0, 0), target: point(6, 6), kind: 'extracted' },
    ]

    drawGraph(ctx, { nodes: [], edges, transform: IDENTITY, colorMode: 'attribute', isDark: false, now: NOW })

    const strokes = calls.filter((c) => c.op === 'stroke')
    // A per-edge beginPath/stroke loop would produce 6 stroke calls here
    // instead of 2 — this is the 40x-cost regression the batching exists to
    // prevent, and it is the first thing this assertion would catch.
    expect(strokes).toHaveLength(2)
    expect(strokes.map((s) => s.strokeStyle)).toEqual(expect.arrayContaining(['#2B6E6B', '#1C1A16']))
    expect((ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(6)
  })

  it('batches aggregated (kind-less, weighted) edges into exactly one muted stroke() call', () => {
    const { ctx, calls } = createFakeCtx()
    const edges: DrawEdge[] = [
      { source: point(0, 0), target: point(1, 1), weight: 2 },
      { source: point(0, 0), target: point(2, 2), weight: 5 },
      { source: point(0, 0), target: point(3, 3), weight: 1 },
      { source: point(0, 0), target: point(4, 4), weight: 9 },
    ]

    drawGraph(ctx, { nodes: [], edges, transform: IDENTITY, colorMode: 'attribute', isDark: false, now: NOW })

    const strokes = calls.filter((c) => c.op === 'stroke')
    expect(strokes).toHaveLength(1)
    expect(strokes[0]?.strokeStyle).toBe('#6B6558')
  })
})

describe('decayAlpha', () => {
  const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

  it('is fresh (1.0) under 7 days old', () => {
    expect(decayAlpha(daysAgo(3), NOW)).toBe(1)
  })

  it('is strictly between the floor and fresh for a mid-range age', () => {
    // A decay that ignores the timestamp entirely would collapse this to
    // exactly 1 (or exactly the floor) instead of a real interpolated value.
    const alpha = decayAlpha(daysAgo(90), NOW)
    expect(alpha).toBeGreaterThan(0.25)
    expect(alpha).toBeLessThan(1)
  })

  it('floors at 0.25 for anything past 180 days', () => {
    expect(decayAlpha(daysAgo(400), NOW)).toBe(0.25)
  })

  it('treats a null timestamp as fresh, not stale', () => {
    expect(decayAlpha(null, NOW)).toBe(1)
  })
})

describe('drawGraph — colour modes are exclusive', () => {
  const baseMember = {
    id: 'n',
    tags: [] as string[],
    updatedAt: null as string | null, // alpha stays 1 → no desaturation blend to confound the comparison
    radius: 5,
    x: 0,
    y: 0,
  }

  it('same type, different community: fills differ under community mode, match under attribute mode', () => {
    const nodes: DrawNode[] = [
      { ...baseMember, id: 'a', type: 'note', community: 0 },
      { ...baseMember, id: 'b', type: 'note', community: 1 },
    ]

    const community = createFakeCtx()
    drawGraph(community.ctx, { nodes, edges: [], transform: IDENTITY, colorMode: 'community', isDark: false, now: NOW })
    const communityFills = community.calls.filter((c) => c.op === 'fill').map((c) => c.fillStyle)
    expect(communityFills[0]).not.toBe(communityFills[1])

    const attribute = createFakeCtx()
    drawGraph(attribute.ctx, { nodes, edges: [], transform: IDENTITY, colorMode: 'attribute', isDark: false, now: NOW })
    const attributeFills = attribute.calls.filter((c) => c.op === 'fill').map((c) => c.fillStyle)
    // Layering both axes (the design explicitly rejected this) would make
    // community leak into attribute mode and this would fail.
    expect(attributeFills[0]).toBe(attributeFills[1])
  })

  it('same community, different type: fills match under community mode, differ under attribute mode', () => {
    const nodes: DrawNode[] = [
      { ...baseMember, id: 'a', type: 'note', community: 4 },
      { ...baseMember, id: 'b', type: 'code', community: 4 },
    ]

    const community = createFakeCtx()
    drawGraph(community.ctx, { nodes, edges: [], transform: IDENTITY, colorMode: 'community', isDark: false, now: NOW })
    const communityFills = community.calls.filter((c) => c.op === 'fill').map((c) => c.fillStyle)
    expect(communityFills[0]).toBe(communityFills[1])

    const attribute = createFakeCtx()
    drawGraph(attribute.ctx, { nodes, edges: [], transform: IDENTITY, colorMode: 'attribute', isDark: false, now: NOW })
    const attributeFills = attribute.calls.filter((c) => c.op === 'fill').map((c) => c.fillStyle)
    expect(attributeFills[0]).not.toBe(attributeFills[1])
  })
})

describe('drawGraph — colour mode is meaningful for community super-nodes', () => {
  // GraphCanvas's *aggregated* (Home) view only ever draws
  // DrawCommunityNode shapes — a colour mode that produces the same fill
  // for these, in both modes, is a toggle that visibly does nothing on the
  // one screen it's rendered on. See the unit 1c review's finding on
  // GraphCanvas.tsx:99 / draw.ts:117-128.
  const baseCommunity = { id: 'c', lastActivity: null as string | null, radius: 8, x: 0, y: 0 }

  it('a community super-node paints differently under attribute mode than under community mode', () => {
    const nodes: DrawNode[] = [{ ...baseCommunity, community: 2 }]

    const community = createFakeCtx()
    drawGraph(community.ctx, { nodes, edges: [], transform: IDENTITY, colorMode: 'community', isDark: false, now: NOW })
    const communityFill = community.calls.find((c) => c.op === 'fill')?.fillStyle

    const attribute = createFakeCtx()
    drawGraph(attribute.ctx, { nodes, edges: [], transform: IDENTITY, colorMode: 'attribute', isDark: false, now: NOW })
    const attributeFill = attribute.calls.find((c) => c.op === 'fill')?.fillStyle

    // A regression back to "both branches return hueAt(node.community)"
    // would make these equal again.
    expect(attributeFill).not.toBe(communityFill)
  })

  it('two community super-nodes with different community numbers still look identical under attribute mode (no attribute to show)', () => {
    const nodes: DrawNode[] = [
      { ...baseCommunity, id: 'a', community: 0 },
      { ...baseCommunity, id: 'b', community: 1 },
    ]
    const { ctx, calls } = createFakeCtx()
    drawGraph(ctx, { nodes, edges: [], transform: IDENTITY, colorMode: 'attribute', isDark: false, now: NOW })
    const fills = calls.filter((c) => c.op === 'fill').map((c) => c.fillStyle)
    expect(fills[0]).toBe(fills[1])
  })
})

describe('drawGraph — category hues never include the authorship tokens', () => {
  it('never uses vermillion (#BA3B1D / #E2683F) as a node fill, in either theme', () => {
    const nodes: DrawNode[] = Array.from({ length: 5 }, (_, i) => ({
      id: `n${i}`,
      type: `type-${i}`,
      tags: [],
      updatedAt: null,
      community: i,
      radius: 5,
      x: i,
      y: i,
    }))
    const vermillion = ['#ba3b1d', '#e2683f']
    for (const isDark of [false, true]) {
      const { ctx, calls } = createFakeCtx()
      drawGraph(ctx, { nodes, edges: [], transform: IDENTITY, colorMode: 'attribute', isDark, now: NOW })
      const fills = calls.filter((c) => c.op === 'fill').map((c) => String(c.fillStyle).toLowerCase())
      for (const fill of fills) expect(vermillion).not.toContain(fill)
    }
  })

  it('uses a different, higher-contrast palette in dark mode than in light mode', () => {
    const nodes: DrawNode[] = [{ id: 'a', type: 'note', tags: [], updatedAt: null, community: 0, radius: 5, x: 0, y: 0 }]

    const light = createFakeCtx()
    drawGraph(light.ctx, { nodes, edges: [], transform: IDENTITY, colorMode: 'attribute', isDark: false, now: NOW })
    const dark = createFakeCtx()
    drawGraph(dark.ctx, { nodes, edges: [], transform: IDENTITY, colorMode: 'attribute', isDark: true, now: NOW })

    const lightFill = light.calls.find((c) => c.op === 'fill')?.fillStyle
    const darkFill = dark.calls.find((c) => c.op === 'fill')?.fillStyle
    expect(darkFill).not.toBe(lightFill)
  })
})

describe('drawGraph — teal is never a node fill', () => {
  it('never records a teal fillStyle, in either theme or colour mode', () => {
    const nodes: DrawNode[] = [
      { id: 'a', type: 'note', tags: [], updatedAt: null, community: 0, radius: 5, x: 0, y: 0 },
      { id: 'b', type: 'code', tags: [], updatedAt: '2020-01-01T00:00:00.000Z', community: 3, radius: 5, x: 1, y: 1 },
      { id: 'c', community: 2, lastActivity: null, radius: 8, x: 2, y: 2 },
    ]
    const teals = ['#2B6E6B', '#4FA39F']

    for (const isDark of [false, true]) {
      for (const colorMode of ['attribute', 'community'] as const) {
        const { ctx, calls } = createFakeCtx()
        drawGraph(ctx, { nodes, edges: [], transform: IDENTITY, colorMode, isDark, now: NOW })
        const fills = calls.filter((c) => c.op === 'fill').map((c) => String(c.fillStyle))
        for (const fill of fills) {
          expect(teals).not.toContain(fill)
        }
      }
    }
  })
})
