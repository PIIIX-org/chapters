// The real community-cluster graph renderer for unit 1c. Hand-rolled
// Canvas 2D + d3-force for layout, plus the Pointer Events pan/pinch module
// from task 3 — no graph library. See the unit 1c task notes and
// docs/superpowers/specs/2026-08-22-remaining-ui-design.md for the decision.
//
// This file (plus panzoom.ts, draw.ts, simulation.ts) is loaded only via
// HomePage's lazy() import, never statically from the shell — that's what
// keeps d3-force out of the entry chunk (client/src/bundle.test.ts).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Filter, Info, ListTree, Maximize, Route, Sliders, ZoomIn, ZoomOut } from 'lucide-react'
import { useGraph } from '../../hooks/useGraph.js'
import { useVaults } from '../../hooks/useVaults.js'
import type { CommunityEdge, CommunityGraph, CommunityNode, GraphEdge, GraphNode, PathFindingResult, VaultGraph } from '../../api/graph.js'
import { ContextPanel, Inspector, PanelRailButton, PanelRailNav } from '../shell/ShellPanels.js'
import { useOptionalShell } from '../shell/shell-context.js'
import { Button } from '../ui/button.js'
import { Eyebrow } from '../ui/eyebrow.js'
import { GraphSkeleton } from './GraphSkeleton.js'
import { GraphOutline } from './GraphOutline.js'
import { CommunityDetail } from './CommunityDetail.js'
import { ColorModeToggle } from './ColorModeToggle.js'
import { PhysicsControls } from './PhysicsControls.js'
import { GraphPathfinder } from './GraphPathfinder.js'
import { GraphFilters, graphFiltersFromSearchParams, type FilterableNode } from './GraphFilters.js'
import { CappedGroupsNotice, GraphEmptyState, GraphErrorState, TruncationNotice } from './GraphStates.js'
import { createPanZoom, fitTransform, screenToWorld, type Transform } from './panzoom.js'
import { communityHue, drawGraph, type ColorMode, type DrawAggregatedEdge, type DrawMemberEdge } from './draw.js'
import { createSimulation, DEFAULT_SIMULATION_PARAMS, type SimEdge, type SimNode, type SimulationParams } from './simulation.js'
import { hitTest } from './hitTest.js'
import { cn } from '../../lib/utils.js'

// Task 9's filter options come from the currently loaded graph, not a
// hardcoded list. An aggregated CommunityGraph has no per-node type/tags
// (it's counts, not individual notes), so the only graph shape that can
// ever supply them here is a non-aggregated VaultGraph.
function filterableNodesOf(data: VaultGraph | CommunityGraph | undefined): FilterableNode[] {
  if (!data || 'aggregated' in data) return []
  return data.nodes
}

interface CommunitySimNode extends SimNode {
  community: number
  lastActivity: string | null
  noteCount: number
  codeCount: number
  size: number
}

type CommunitySimEdge = SimEdge<CommunitySimNode>

// Golden-angle spiral: cheap, deterministic, non-overlapping initial
// placement so nodes don't all start stacked at the origin. d3-force would
// otherwise assign its own (also spiral-based) initial positions, but doing
// it here keeps x/y required numbers on CommunitySimNode instead of the
// optional-until-initialized types d3 declares.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

function toSimNodes(nodes: CommunityNode[]): CommunitySimNode[] {
  return nodes.map((n, i) => {
    const spread = 8 * Math.sqrt(i)
    const angle = i * GOLDEN_ANGLE
    return {
      id: n.id,
      community: n.community,
      lastActivity: n.lastActivity,
      noteCount: n.noteCount,
      codeCount: n.codeCount,
      size: n.size,
      radius: Math.min(32, Math.max(4, Math.sqrt(n.size) * 2)),
      x: spread * Math.cos(angle),
      y: spread * Math.sin(angle),
    }
  })
}

function toSimEdges(edges: CommunityEdge[]): CommunitySimEdge[] {
  return edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight }))
}

function isCommunityGraph(data: VaultGraph | CommunityGraph): data is CommunityGraph {
  return 'aggregated' in data && data.aggregated === true
}

// Same shape, same golden-angle spiral placement as the community
// super-nodes above, for the real notes/files a drill-down reveals. A fixed
// radius stands in for "size" here — an individual member has no analogous
// size metric the way a community super-node's `size` does.
const MEMBER_RADIUS = 6

interface MemberSimNode extends SimNode {
  path: string
  resourceId: string
  resourceType: 'note' | 'code'
  type: string | null
  tags: string[]
  updatedAt: string | null
  community: number
}

type MemberSimEdge = SimEdge<MemberSimNode> & { kind: GraphEdge['kind'] }

function toMemberSimNodes(nodes: GraphNode[]): MemberSimNode[] {
  return nodes.map((n, i) => {
    const spread = 8 * Math.sqrt(i)
    const angle = i * GOLDEN_ANGLE
    return {
      id: n.id,
      path: n.path,
      resourceId: n.resourceId,
      resourceType: n.resourceType,
      type: n.type,
      tags: n.tags,
      updatedAt: n.updatedAt,
      community: n.community,
      radius: MEMBER_RADIUS,
      x: spread * Math.cos(angle),
      y: spread * Math.sin(angle),
    }
  })
}

function toMemberSimEdges(edges: GraphEdge[]): MemberSimEdge[] {
  return edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }))
}

// A pointer that has moved more than this many CSS pixels between down and
// up is a pan, not a tap — matches the panzoom module's own screen-space
// units (clientX/clientY, unscaled by devicePixelRatio).
const TAP_MAX_SCREEN_DRIFT = 6

export default function GraphCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Lazy initializer runs during render, not as a setState-in-effect, and
  // this only needs to be read once: reduced motion is what decides whether
  // `settled` is ever meaningful for this mount at all (see below).
  const [reducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [settled, setSettled] = useState(false)
  // The one place expansion state lives. A canvas tap and a keyboard Enter
  // on the matching GraphOutline button both end up calling
  // `setExpandedCommunity` with the same community id — neither input owns
  // a copy of its own.
  const [expandedCommunity, setExpandedCommunity] = useState<number | null>(null)
  // Which community the cursor is over on the canvas — read only by the
  // inspector's CommunityDetail. React bails out of re-rendering when a
  // pointermove resolves to the value already set, so this is cheap to
  // update per move event.
  const [hoveredCommunity, setHoveredCommunity] = useState<number | null>(null)
  const [hoveredTooltip, setHoveredTooltip] = useState<{
    node: CommunitySimNode | MemberSimNode
    x: number
    y: number
  } | null>(null)

  // Same URL, same router as ColorModeToggle — reading it here rather than
  // taking colorMode/filters as props makes the URL the one shared source
  // of truth everywhere, exactly as task 7 requires for "a shared link
  // reproduces the view". Task 9's filters (types/tags/since/until) join
  // vault/color here for the same reason: GraphFilters writes them, this
  // reads them, and both go through the same router.
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const shell = useOptionalShell()
  const isInspectorOpen = !!(shell?.panels.inspector.open && (shell?.panels.inspector.mounted ?? 0) > 0)
  const isSidebarExpanded = !!shell?.sidebarExpanded
  const colorMode: ColorMode = searchParams.get('color') === 'community' ? 'community' : 'attribute'
  const filters = graphFiltersFromSearchParams(searchParams)
  const graph = useGraph(null, filters)
  // Same queryKey as GraphOutline's own member fetch when a community is
  // expanded (react-query dedupes by content, so this is a cache hit, not a
  // second request) — read here only for the drill-down "showing N of M"
  // notice below, which lives beside the canvas rather than in the outline.
  const activeGraph = useGraph(expandedCommunity, filters)
  // The real member graph once a drill-down's fetch resolves — `null`
  // while collapsed, and also `null` while a just-expanded fetch is still
  // pending, so a tap keeps showing the aggregated view (never a blank
  // canvas) until real member data is ready to replace it. Referentially
  // stable between renders (react-query's own cached object, or the same
  // `null`) so it's safe as an effect dependency below.
  const memberData: VaultGraph | null =
    expandedCommunity !== null && activeGraph.data && !isCommunityGraph(activeGraph.data) ? activeGraph.data : null
  // HomePage never mounts this component with zero vaults (task 1's empty
  // state intercepts that case first), so a vault always exists here — this
  // is only which one "Create a note" should land on.
  const vaults = useVaults()
  const createNoteHref = `/vaults/${searchParams.get('vault') ?? vaults.data?.[0]?.id ?? ''}`
  // Read by the rAF loop's draw() closure (declared once, inside the effect
  // below, keyed to graph.data/reducedMotion — not to colorMode). A ref
  // lets a colour-mode change reach that closure without re-running the
  // effect, which would tear down and re-heat the simulation for a change
  // that is purely cosmetic.
  const colorModeRef = useRef(colorMode)
  // Set by the main effect below to request one redraw without ticking the
  // simulation — the same "idle -> redraw" transition panzoom's own
  // onChange already uses. Shared by the colour-mode toggle (below) and by
  // task 8's node-size/edge-width sliders (further down): every one of
  // them is a paint-only change.
  const requestRedrawRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    colorModeRef.current = colorMode
    requestRedrawRef.current?.()
  }, [colorMode])

  // Task 8's node-size / edge-width sliders read here every draw(). Refs,
  // not state: nothing in this component renders differently because of
  // them, so there is nothing a re-render would buy — draw() already picks
  // up a ref mutation on its very next call via requestRedrawRef.
  const nodeSizeScaleRef = useRef(1)
  const edgeWidthScaleRef = useRef(1)

  // Task 8's force-strength / link-distance / clustering-tightness
  // sliders. Set by the main effect below to the real setParams from
  // createSimulation, wrapped so a physics change also resumes the rAF
  // loop if it had gone idle — setParams only raises alpha
  // (simulation.ts), it never restarts d3-force's own timer, so nothing
  // ticks again unless this loop notices and drives it.
  const updatePhysicsParamsRef = useRef<((next: Partial<SimulationParams>) => void) | null>(null)
  // The latest physics params, read from inside the main effect below (an
  // effect may read a ref freely without depending on it) so a filter
  // change or a community drill-down — both of which tear down and rebuild
  // the simulation — seed the new one from wherever the user last left the
  // sliders instead of silently snapping back to DEFAULT_SIMULATION_PARAMS.
  // PhysicsControls itself only ever reads its `initialParams` prop once,
  // at its own mount (it's never remounted here), so this only needs to
  // reach the simulation, not round-trip back into that panel's display.
  const simParamsRef = useRef<SimulationParams>(DEFAULT_SIMULATION_PARAMS)
  // Pan/zoom position, carried across the same rebuilds for the same
  // reason: without this, changing a filter recentres the viewport back to
  // {x:0,y:0,k:1} out from under whatever the user had panned/zoomed to.
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 })

  // The bottom-right zoom buttons live outside the effect that owns the
  // panzoom instance; the effect publishes the two operations they need
  // here (same pattern as requestRedrawRef above).
  const zoomApiRef = useRef<{ zoomBy: (factor: number) => void; fit: () => void } | null>(null)

  function handlePhysicsChange(next: Partial<SimulationParams>) {
    updatePhysicsParamsRef.current?.(next)
  }
  function handleNodeSizeChange(value: number) {
    nodeSizeScaleRef.current = value
    requestRedrawRef.current?.()
  }
  function handleEdgeWidthChange(value: number) {
    edgeWidthScaleRef.current = value
    requestRedrawRef.current?.()
  }

  const activePathRef = useRef<PathFindingResult | null>(null)

  function handlePathChange(path: PathFindingResult | null) {
    activePathRef.current = path
    requestRedrawRef.current?.()
  }


  useEffect(() => {
    // No `setSettled(false)` reset here on purpose: react-hooks bans a
    // synchronous setState call at the top of an effect body (cascading
    // renders). A drill-down or filter change rebuilding mid-mount simply
    // keeps whatever `settled` already was — reduced-motion users only ever
    // cared about not seeing the *initial* thrash.
    const displayData: VaultGraph | CommunityGraph | undefined = memberData ?? graph.data
    if (!displayData) return

    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    // happy-dom's canvas.getContext('2d') returns null — this guard is what
    // lets the component mount under happy-dom at all; everything below it
    // never runs unless a test stubs getContext with a fake context.
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let dpr = 1
    function resize() {
      dpr = window.devicePixelRatio || 1
      const { clientWidth, clientHeight } = container!
      canvas!.width = Math.max(1, Math.round(clientWidth * dpr))
      canvas!.height = Math.max(1, Math.round(clientHeight * dpr))
      canvas!.style.width = `${clientWidth}px`
      canvas!.style.height = `${clientHeight}px`
    }
    resize()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    ro?.observe(container)

    // Tapping a community super-node drills into its real members
    // (VaultGraph) instead of leaving the aggregated super-nodes on screen
    // forever — this is the one branch point between the two node/edge
    // shapes the canvas ever draws.
    const nodes: (CommunitySimNode | MemberSimNode)[] = isCommunityGraph(displayData)
      ? toSimNodes(displayData.nodes)
      : toMemberSimNodes(displayData.nodes)
    const edges: (CommunitySimEdge | MemberSimEdge)[] = isCommunityGraph(displayData)
      ? toSimEdges(displayData.edges)
      : toMemberSimEdges(displayData.edges)
    const { sim, setParams } = createSimulation(nodes, edges, simParamsRef.current)

    // forceLink resolves every edge.source/target from an id string to the
    // matching node object the moment it's attached inside createSimulation
    // (which already happened, above) — so by this point every edge here is
    // already a resolved node pair, not a string. drawGraph only reads x/y
    // off these same objects, which sim.tick() mutates in place.
    const drawEdges = edges as unknown as (DrawAggregatedEdge | DrawMemberEdge)[]

    const isDark = document.documentElement.classList.contains('dark')

    let rafId: number | null = null
    let mode: 'running' | 'settling' | 'redraw' | 'idle' = reducedMotion ? 'settling' : 'running'

    function draw() {
      const pathNodeIds = activePathRef.current?.found
        ? new Set(activePathRef.current.nodes.map((n) => n.id))
        : null
      const pathEdges =
        activePathRef.current?.found && pathNodeIds
          ? drawEdges
              .filter((e) => 'kind' in e)
              .filter((e) => {
                const s = e.source as unknown as { id?: string }
                const t = e.target as unknown as { id?: string }
                return Boolean(s?.id && t?.id && pathNodeIds.has(s.id) && pathNodeIds.has(t.id))
              })
          : null

      drawGraph(ctx!, {
        nodes,
        edges: drawEdges,
        transform: {
          x: panzoom.transform.x * dpr,
          y: panzoom.transform.y * dpr,
          k: panzoom.transform.k * dpr,
        },
        colorMode: colorModeRef.current,
        isDark,
        now: Date.now(),
        nodeSizeScale: nodeSizeScaleRef.current,
        edgeWidthScale: edgeWidthScaleRef.current,
        highlightPathNodeIds: pathNodeIds,
        highlightPathEdges: pathEdges,
      })
    }


    function requestFrame() {
      if (rafId === null) rafId = requestAnimationFrame(frame)
    }

    function frame() {
      rafId = null
      if (mode === 'running') {
        sim.tick()
        draw()
        mode = sim.alpha() < sim.alphaMin() ? 'idle' : 'running'
        if (mode === 'running') requestFrame()
        return
      }
      if (mode === 'settling') {
        // At most 20 ticks per frame: pre-settling synchronously (a `for`
        // loop of hundreds of ticks in one go) blocks the main thread for
        // over a second at 2000 nodes — freezing the tab for exactly the
        // reduced-motion users this is meant to accommodate.
        for (let i = 0; i < 20 && sim.alpha() >= sim.alphaMin(); i++) sim.tick()
        if (sim.alpha() < sim.alphaMin()) {
          draw()
          mode = 'idle'
          setSettled(true)
        } else {
          requestFrame()
        }
        return
      }
      if (mode === 'redraw') {
        draw()
        mode = 'idle'
      }
    }

    // First mount only: the simulation's forceCenter keeps the cluster
    // centred on world (0,0), but the identity transform puts world (0,0) at
    // the canvas's TOP-LEFT — the whole graph loaded cropped into the corner
    // (slice-8 QA screenshots). Centring the origin once centres the cluster
    // for the life of the mount; later rebuilds keep the user's own camera.
    const t0 = transformRef.current
    if (t0.x === 0 && t0.y === 0 && t0.k === 1) {
      transformRef.current = { x: container.clientWidth / 2, y: container.clientHeight / 2, k: 1 }
    }

    const panzoom = createPanZoom(
      canvas,
      (t) => {
        // Kept live so the *next* rebuild (a filter change or a community
        // drill-down, both of which tear this effect down and re-run it)
        // starts from here instead of snapping back to {x:0,y:0,k:1}.
        transformRef.current = t
        // A settled graph idles at zero draws per second; panning/zooming it
        // schedules exactly one more redraw, never a tick.
        if (mode === 'idle') {
          mode = 'redraw'
          requestFrame()
        }
      },
      transformRef.current,
    )

    // Same idle -> redraw transition as panzoom's onChange above, triggered
    // by a colour-mode change or a node-size/edge-width slider instead of a
    // pointer gesture. Exposed via the ref the outer handlers call, since
    // colorModeRef/nodeSizeScaleRef/edgeWidthScaleRef are already updated
    // by the time this runs.
    requestRedrawRef.current = () => {
      if (mode === 'idle') {
        mode = 'redraw'
        requestFrame()
      }
    }

    // Task 8's force-strength / link-distance / clustering-tightness
    // sliders. setParams (simulation.ts) only raises alpha — it never
    // calls sim.restart(), so if this loop had already gone idle nothing
    // would tick again unless something here notices alpha rose and
    // resumes driving frame().
    updatePhysicsParamsRef.current = (next) => {
      setParams(next)
      simParamsRef.current = { ...simParamsRef.current, ...next }
      if (mode !== 'running') {
        // Reduced-motion users get the same batched settle a fresh load
        // gives them, not the full one-tick-per-frame animation a physics
        // re-heat would otherwise drop them into for the whole alpha decay.
        mode = reducedMotion ? 'settling' : 'running'
        requestFrame()
      }
    }

    // Tap-to-expand: a separate, minimal pointerdown/pointerup pair, run
    // alongside panzoom's own listeners on the same element. A single
    // pointer that hasn't drifted more than TAP_MAX_SCREEN_DRIFT between
    // down and up is a tap; two pointers down at once means a pinch
    // started, which cancels the tap candidate outright. Coordinates are
    // converted to element-local (raw clientX/Y minus the canvas rect,
    // same convention as panzoom's localPoint — raw coordinates are off
    // by the shell's rail/panel offsets), then world-space with
    // `screenToWorld` and this frame's transform BEFORE hit-testing.
    let tap: { pointerId: number; x: number; y: number } | null = null

    function onPointerDownForTap(e: PointerEvent) {
      tap = tap === null ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY } : null
    }

    function onPointerUpForTap(e: PointerEvent) {
      const candidate = tap
      tap = null
      if (!candidate || candidate.pointerId !== e.pointerId) return
      if (Math.hypot(e.clientX - candidate.x, e.clientY - candidate.y) > TAP_MAX_SCREEN_DRIFT) return

      const rect = canvas!.getBoundingClientRect()
      const world = screenToWorld(panzoom.transform, e.clientX - rect.left, e.clientY - rect.top)
      const hitNode = hitTest(nodes, world.x, world.y, (n) => n.radius)
      if (!hitNode) return

      if ('path' in hitNode) {
        const target =
          hitNode.resourceType === 'note'
            ? `/vaults/${hitNode.resourceId}/notes/${hitNode.path}`
            : `/repos/${hitNode.resourceId}/files/${hitNode.path}`
        navigate(target)
      } else {
        setExpandedCommunity(hitNode.community)
      }
    }

    function onPointerCancelForTap() {
      tap = null
    }

    // Hover: the inspector mirrors whatever community is under the cursor.
    // Same coordinate convention as the tap handler above (screenToWorld
    // before hit-testing, never raw screen coordinates).
    function onPointerMoveForHover(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect()
      const clientX = e.clientX - rect.left
      const clientY = e.clientY - rect.top
      const world = screenToWorld(panzoom.transform, clientX, clientY)
      const hitNode = hitTest(nodes, world.x, world.y, (n) => n.radius)
      if (canvas) canvas.style.cursor = hitNode ? 'pointer' : 'grab'
      setHoveredCommunity(hitNode ? hitNode.community : null)
      if (hitNode) {
        setHoveredTooltip({
          node: hitNode,
          x: Math.min(clientX + 12, rect.width - 240),
          y: Math.max(12, Math.min(clientY + 12, rect.height - 110)),
        })
      } else {
        setHoveredTooltip(null)
      }
    }
    function onPointerLeaveForHover() {
      if (canvas) canvas.style.cursor = 'grab'
      setHoveredCommunity(null)
      setHoveredTooltip(null)
    }

    canvas.addEventListener('pointerdown', onPointerDownForTap)
    canvas.addEventListener('pointerup', onPointerUpForTap)
    canvas.addEventListener('pointercancel', onPointerCancelForTap)
    canvas.addEventListener('pointermove', onPointerMoveForHover)
    canvas.addEventListener('pointerleave', onPointerLeaveForHover)

    // The bottom-right zoom buttons. zoomBy zooms about the element centre;
    // fit recentres the current node set in the viewport. Both emit through
    // panzoom's onChange, which already schedules the redraw.
    zoomApiRef.current = {
      zoomBy: (factor) => panzoom.zoomBy(factor),
      fit: () => {
        const t = fitTransform(nodes, container!.clientWidth, container!.clientHeight)
        if (t) panzoom.setTransform(t)
      },
    }

    requestFrame()

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      sim.stop()
      panzoom.destroy()
      requestRedrawRef.current = null
      updatePhysicsParamsRef.current = null
      zoomApiRef.current = null
      canvas.removeEventListener('pointerdown', onPointerDownForTap)
      canvas.removeEventListener('pointerup', onPointerUpForTap)
      canvas.removeEventListener('pointercancel', onPointerCancelForTap)
      canvas.removeEventListener('pointermove', onPointerMoveForHover)
      canvas.removeEventListener('pointerleave', onPointerLeaveForHover)
      ro?.disconnect()
    }
  }, [graph.data, memberData, reducedMotion, navigate])

  // Non-reduced-motion has nothing to hide behind the skeleton for — the
  // canvas starts drawing live on its very first frame. Only the
  // reduced-motion path withholds the reveal until settle() finishes.
  const showSkeleton = graph.isPending || (reducedMotion && !settled)
  const communities = graph.data && isCommunityGraph(graph.data) ? graph.data.nodes : []
  // A community graph with zero nodes is a real, successful result (an
  // empty vault) — not the same thing as `graph.isError`, and must not
  // render the two-pane canvas layout over either.
  const isEmpty = !!graph.data && isCommunityGraph(graph.data) && graph.data.nodes.length === 0
  const isMergedView = !searchParams.get('vault')
  const hasVaults = (vaults.data?.length ?? 0) > 0

  if (graph.isError) {
    return (
      <div data-testid="graph-canvas" className="h-full w-full">
        <GraphErrorState message={graph.error.message} onRetry={() => graph.refetch()} />
      </div>
    )
  }

  if (isEmpty) {
    return (
      <div data-testid="graph-canvas" className="h-full w-full">
        <GraphEmptyState
          createNoteHref={createNoteHref}
          title={isMergedView && hasVaults ? 'No notes in merged view' : undefined}
          message={
            isMergedView && hasVaults
              ? 'To fold your notes into this view, turn on merging in vault settings, or pick a specific vault from the scope picker above.'
              : undefined
          }
        />
      </div>
    )
  }

  const memberGraph: VaultGraph | null =
    memberData && !isCommunityGraph(memberData)
      ? memberData
      : graph.data && !isCommunityGraph(graph.data)
        ? graph.data
        : null

  return (
    <div data-testid="graph-canvas" className="relative flex h-full w-full flex-col bg-background">
      {/* Stats strip floating at the top center — mono numerals, always computed
          from the aggregated graph even while drilled into a community. */}
      {graph.data && isCommunityGraph(graph.data) && (
        <div className="pointer-events-none absolute top-2.5 left-1/2 -translate-x-1/2 z-10 flex items-center">
          <StatsStrip vaultCount={vaults.data?.length ?? null} graph={graph.data} />
        </div>
      )}

      <div
        ref={containerRef}
        className="relative min-h-0 w-full flex-1 overflow-hidden bg-background bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:48px_48px] [background-position:center]"
      >
        <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />

        {/* Colour-mode pills: positioned safely to the right of the Rail */}
        <div
          className={cn(
            'absolute top-[54px] z-10 transition-[left] duration-200',
            isSidebarExpanded ? 'left-[264px]' : 'left-16',
          )}
        >
          <ColorModeToggle />
        </div>

        {/* Zoom controls: shifted left of Inspector when open, positioned above BottomBar toggles */}
        <div
          className={cn(
            'absolute bottom-14 z-10 flex flex-col gap-1 transition-[right] duration-200',
            isInspectorOpen ? 'right-[340px]' : 'right-3',
          )}
        >
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Zoom in"
            onClick={() => zoomApiRef.current?.zoomBy(1.4)}
            className="rounded-[var(--radius-md,4px)] border border-border bg-card/90 backdrop-blur-xs shadow-floating text-muted-foreground hover:text-foreground hover:bg-muted active:scale-95"
          >
            <ZoomIn aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Zoom out"
            onClick={() => zoomApiRef.current?.zoomBy(1 / 1.4)}
            className="rounded-[var(--radius-md,4px)] border border-border bg-card/90 backdrop-blur-xs shadow-floating text-muted-foreground hover:text-foreground hover:bg-muted active:scale-95"
          >
            <ZoomOut aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Fit graph to view"
            onClick={() => zoomApiRef.current?.fit()}
            className="rounded-[var(--radius-md,4px)] border border-border bg-card/90 backdrop-blur-xs shadow-floating text-muted-foreground hover:text-foreground hover:bg-muted active:scale-95"
          >
            <Maximize aria-hidden="true" />
          </Button>
        </div>

        {/* Non-blocking: capped/truncation notices clear of lower rail and above BottomBar */}
        <div
          className={cn(
            'absolute bottom-14 z-10 flex max-w-[calc(100vw-360px)] flex-col items-start gap-2 transition-[left] duration-200',
            isSidebarExpanded ? 'left-[264px]' : 'left-16',
          )}
        >
          <CappedGroupsNotice groups={graph.data?.cappedGroups ?? []} />
          {expandedCommunity !== null && activeGraph.data && !isCommunityGraph(activeGraph.data) && (
            <TruncationNotice
              shown={activeGraph.data.nodes.length}
              total={activeGraph.data.memberTotal ?? activeGraph.data.nodes.length}
            />
          )}
        </div>

        {/* The canvas is presentation-only (aria-hidden). It has zero
            accessible content of its own — GraphOutline, in the context
            panel, is the real keyboard-operable interface; this skeleton is
            the only thing screen readers see from this half of the layout. */}
        {showSkeleton && (
          <div className="absolute inset-0">
            <GraphSkeleton />
          </div>
        )}

        {/* Floating Node Telemetry HUD Tooltip */}
        {hoveredTooltip && (
          <div
            className="pointer-events-none absolute z-20 transition-opacity duration-100"
            style={{
              left: hoveredTooltip.x,
              top: hoveredTooltip.y,
            }}
          >
            {'path' in hoveredTooltip.node ? (
              <div className="flex max-w-xs flex-col gap-1 rounded-[var(--radius-sm,2px)] border border-border bg-card/95 px-2.5 py-1.5 shadow-floating backdrop-blur-xs text-xs">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'rounded px-1 py-0.5 text-[9px] font-sans font-semibold uppercase tracking-wider',
                      hoveredTooltip.node.resourceType === 'note'
                        ? 'bg-primary/15 text-primary'
                        : 'bg-[oklch(0.72_0.14_186)]/15 text-[oklch(0.72_0.14_186)]',
                    )}
                  >
                    {hoveredTooltip.node.resourceType}
                  </span>
                  {hoveredTooltip.node.type && (
                    <span className="rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
                      {hoveredTooltip.node.type}
                    </span>
                  )}
                  {hoveredTooltip.node.updatedAt && (
                    <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                      {new Date(hoveredTooltip.node.updatedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] font-medium text-foreground" title={hoveredTooltip.node.path}>
                  {hoveredTooltip.node.path}
                </div>
                {hoveredTooltip.node.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {hoveredTooltip.node.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="text-[10px] text-muted-foreground">
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
                <div className="pt-0.5 text-[10px] text-primary">Click node to open</div>
              </div>
            ) : (
              <div className="flex flex-col gap-1 rounded-[var(--radius-sm,2px)] border border-border bg-card/95 px-2.5 py-1.5 shadow-floating backdrop-blur-xs text-xs">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <span
                    className="size-2 rounded-full"
                    style={{
                      backgroundColor: communityHue(
                        hoveredTooltip.node.community,
                        typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
                      ),
                    }}
                  />
                  <span>Community {hoveredTooltip.node.community}</span>
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  {hoveredTooltip.node.size} members ({hoveredTooltip.node.noteCount} notes, {hoveredTooltip.node.codeCount} code)
                </div>
                <div className="pt-0.5 text-[10px] text-primary">Click to explore members</div>
              </div>
            )}
          </div>
        )}
      </div>

      <ContextPanel
        label="Outline"
        collapsed={
          <PanelRailNav label="Graph outline">
            <PanelRailButton
              icon={ListTree}
              label="Outline"
            />
          </PanelRailNav>
        }
      >
        <GraphOutline
          communities={communities}
          expandedCommunity={expandedCommunity}
          onExpand={setExpandedCommunity}
          onCollapse={() => setExpandedCommunity(null)}
        />
      </ContextPanel>

      <Inspector
        label="Graph detail"
        className="gap-3 p-3"
        collapsed={
          <PanelRailNav label="Graph detail sections">
            <PanelRailButton
              icon={Info}
              label="Community detail"
            />
            <PanelRailButton
              icon={Filter}
              label="Filters"
            />
            {memberGraph && (
              <PanelRailButton
                icon={Route}
                label="Pathfinder"
              />
            )}
            <PanelRailButton
              icon={Sliders}
              label="Physics"
            />
          </PanelRailNav>
        }
      >
        <CommunityDetail
          communities={communities}
          hoveredCommunity={hoveredCommunity}
          expandedCommunity={expandedCommunity}
          onCollapse={() => setExpandedCommunity(null)}
          filters={filters}
        />
        <CollapsibleSection title="Filters">
          <GraphFilters nodes={filterableNodesOf(memberData ?? graph.data)} />
        </CollapsibleSection>
        {memberGraph && (
          <CollapsibleSection title="Pathfinder">
            <GraphPathfinder
              nodes={memberGraph.nodes}
              edges={memberGraph.edges}
              onPathChange={handlePathChange}
            />
          </CollapsibleSection>
        )}
        {/* No initial* props: this stays mounted for the component's whole
            life (a closed <details> keeps its children), so its own state
            already tracks the sliders — while simParamsRef carries the same
            values across simulation rebuilds. */}
        <CollapsibleSection title="Physics">
          <PhysicsControls
            onPhysicsChange={handlePhysicsChange}
            onNodeSizeChange={handleNodeSizeChange}
            onEdgeWidthChange={handleEdgeWidthChange}
          />
        </CollapsibleSection>

      </Inspector>
    </div>
  )
}

/** Native-details collapsible panel for the inspector's Filters / Physics sections. */
function CollapsibleSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details open className="rounded-[var(--radius-md,4px)] border border-border bg-card">
      <summary className="flex h-9 cursor-pointer select-none list-none items-center px-3 [&::-webkit-details-marker]:hidden">
        <Eyebrow as="span">{title}</Eyebrow>
      </summary>
      <div className="border-t border-border p-3">{children}</div>
    </details>
  )
}

const statFormatter = new Intl.NumberFormat('en-US')

function StatsStrip({ vaultCount, graph }: { vaultCount: number | null; graph: CommunityGraph }) {
  let notes = 0
  let codeFiles = 0
  for (const n of graph.nodes) {
    notes += n.noteCount
    codeFiles += n.codeCount
  }
  const stats: [string, number | null][] = [
    ['Vaults', vaultCount],
    ['Notes', notes],
    ['Code files', codeFiles],
    ['Edges', graph.edges.length],
    ['Communities', graph.nodes.length],
  ]
  return (
    <dl
      aria-label="Graph statistics"
      className="pointer-events-auto flex h-9 shrink-0 items-center gap-4 overflow-x-auto rounded-[var(--radius-md,4px)] border border-border bg-card/90 backdrop-blur-xs px-3 shadow-floating"
    >
      {stats.map(([label, value]) =>
        value === null ? null : (
          <div key={label} className="flex items-baseline gap-1.5">
            <dt>
              <Eyebrow>{label}</Eyebrow>
            </dt>
            <dd className="font-mono text-[12px] tabular-nums text-foreground">{statFormatter.format(value)}</dd>
          </div>
        ),
      )}
    </dl>
  )
}
