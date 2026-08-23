import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import GraphCanvas from './GraphCanvas.js'

// Records every call to the real simulation's tick() without changing its
// behaviour, so "settles in batches of at most 20" can be asserted directly
// against the thing that actually runs, not a proxy for it.
// createSimulationParamsSpy also records the (optional) 3rd argument every
// call was actually seeded with — proves a rebuild reuses whatever the
// sliders were last set to, not silently DEFAULT_SIMULATION_PARAMS again.
const { tickSpy, createSimulationParamsSpy } = vi.hoisted(() => ({ tickSpy: vi.fn(), createSimulationParamsSpy: vi.fn() }))
vi.mock('./simulation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./simulation.js')>()
  const wrapped: typeof actual.createSimulation = (...args) => {
    createSimulationParamsSpy(args[2])
    const result = actual.createSimulation(...args)
    const realTick = result.sim.tick.bind(result.sim)
    result.sim.tick = ((n?: number) => {
      tickSpy()
      return realTick(n)
    }) as typeof result.sim.tick
    return result
  }
  return { ...actual, createSimulation: wrapped }
})

// Records the colorMode drawGraph was actually called with, without
// changing its behaviour — proves the toggle's value reaches the real
// draw call, not just component state.
const { drawGraphSpy, drawOptsSpy } = vi.hoisted(() => ({ drawGraphSpy: vi.fn(), drawOptsSpy: vi.fn() }))
vi.mock('./draw.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./draw.js')>()
  const wrapped: typeof actual.drawGraph = (ctx, opts) => {
    drawGraphSpy(opts.colorMode)
    drawOptsSpy(opts)
    return actual.drawGraph(ctx, opts)
  }
  return { ...actual, drawGraph: wrapped }
})

const GRAPH = {
  aggregated: true,
  nodes: [
    { id: 'c0', community: 0, size: 4, noteCount: 3, codeCount: 1, lastActivity: '2026-08-01T00:00:00.000Z' },
    { id: 'c1', community: 1, size: 9, noteCount: 5, codeCount: 4, lastActivity: '2026-08-10T00:00:00.000Z' },
  ],
  edges: [{ source: 'c0', target: 'c1', weight: 2 }],
  cappedGroups: [],
}

function stubFetch() {
  // A fresh Response per call, not one shared instance: a `Response` body
  // can only be read once, and this component alone issues 2+ concurrent
  // fetches at mount (vaults, graph) plus another on every filter/vault
  // change — a shared instance's second `.json()` read silently resolves
  // to `undefined` (caught by apiFetch, then rejected by react-query's own
  // "data cannot be undefined" guard), which earlier single-fetch tests
  // never noticed only because nothing here asserted on the vaults query.
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(mockJsonResponse(200, GRAPH))))
}

function stubMatchMedia(reducedMotion: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion') && reducedMotion,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

// happy-dom's canvas.getContext('2d') returns null, which is exactly the
// guard GraphCanvas relies on to mount safely under happy-dom in the first
// place. To exercise the sim/draw wiring at all, stub it with a fake
// recording context — same technique as draw.test.ts.
function stubCanvasContext() {
  const fakeCtx = {
    canvas: { width: 300, height: 150 },
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
    stroke: vi.fn(),
    fill: vi.fn(),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D)
  return fakeCtx
}

// A manual rAF queue: requestAnimationFrame pushes the callback instead of
// scheduling it, so the test controls exactly when (and how many times) "a
// frame" happens. cancelAnimationFrame removes a still-pending callback by
// the id it was given — close enough to the real thing that a missing
// cancelAnimationFrame in the component shows up as an extra draw here.
function stubManualRaf() {
  const queue = new Map<number, FrameRequestCallback>()
  let nextId = 1
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++
    queue.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue.delete(id)
  })
  function flush() {
    const callbacks = [...queue.values()]
    queue.clear()
    for (const cb of callbacks) cb(0)
  }
  return { flush, pending: () => queue.size }
}

function renderGraphCanvas() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/?vault=v1']}>
        <GraphCanvas />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('GraphCanvas', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    tickSpy.mockClear()
    createSimulationParamsSpy.mockClear()
    drawGraphSpy.mockClear()
    drawOptsSpy.mockClear()
  })

  it('under reduced motion, settles in batches of at most 20 ticks per manually-flushed frame, never all at once', async () => {
    stubFetch()
    stubMatchMedia(true)
    stubCanvasContext()
    const raf = stubManualRaf()

    renderGraphCanvas()

    await waitFor(() => expect(raf.pending()).toBeGreaterThan(0))

    // Nothing has ticked yet: the first settle batch only runs once a frame
    // is actually flushed. A broken implementation that ticks synchronously
    // in the effect (`for (let i = 0; i < 200; i++) sim.tick()`) would
    // already show 200 ticks here, before any frame was flushed at all.
    expect(tickSpy.mock.calls.length).toBeLessThanOrEqual(20)

    let previous = tickSpy.mock.calls.length
    let flushes = 0
    while (raf.pending() > 0 && flushes < 50) {
      raf.flush()
      const delta = tickSpy.mock.calls.length - previous
      expect(delta).toBeLessThanOrEqual(20)
      expect(delta).toBeGreaterThan(0) // ticks continue only as frames flush
      previous = tickSpy.mock.calls.length
      flushes++
    }

    expect(flushes).toBeGreaterThan(1) // this graph needed more than one batch
  })

  it('runs the tick+draw loop until alpha decays below alphaMin, then stops drawing', async () => {
    stubFetch()
    stubMatchMedia(false)
    const fakeCtx = stubCanvasContext()
    const raf = stubManualRaf()
    renderGraphCanvas()

    await waitFor(() => expect(raf.pending()).toBeGreaterThan(0))

    // Flush far more frames than d3-force's default ~300-tick natural
    // lifetime needs to decay past alphaMin, at these node counts.
    for (let i = 0; i < 400 && raf.pending() > 0; i++) raf.flush()

    expect(fakeCtx.clearRect.mock.calls.length).toBeGreaterThan(0)
    expect(raf.pending()).toBe(0)

    const drawCountAtRest = fakeCtx.clearRect.mock.calls.length
    // A loop that never checks alphaMin keeps scheduling itself forever; a
    // settled one has nothing pending, so flushing again is a no-op.
    raf.flush()
    expect(fakeCtx.clearRect.mock.calls.length).toBe(drawCountAtRest)
  })

  it('stops drawing after unmount even if a frame is flushed later', async () => {
    stubFetch()
    stubMatchMedia(false)
    const fakeCtx = stubCanvasContext()
    const raf = stubManualRaf()
    const { unmount } = renderGraphCanvas()

    await waitFor(() => expect(raf.pending()).toBeGreaterThan(0))
    raf.flush()
    const callsBeforeUnmount = fakeCtx.clearRect.mock.calls.length

    unmount()
    raf.flush()

    // A missing cancelAnimationFrame would let the already-queued callback
    // fire post-unmount and draw again.
    expect(fakeCtx.clearRect.mock.calls.length).toBe(callsBeforeUnmount)
  })

  it('renders the canvas as aria-hidden presentation, with the DOM outline as a sibling, not a descendant', async () => {
    stubFetch()
    stubMatchMedia(false)
    stubCanvasContext()
    const { container } = renderGraphCanvas()

    await screen.findByTestId('graph-canvas')
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas).toHaveAttribute('aria-hidden', 'true')

    // GraphOutline's real, keyboard-operable content exists in the
    // document, but never inside the presentation-only canvas.
    const communityButton = await screen.findByRole('button', { name: /Community 0/ })
    expect(canvas).not.toContainElement(communityButton)
    expect(canvas?.children.length).toBe(0)
  })

  // axe passes on a bare canvas with zero accessible content — this proves
  // only that the surrounding markup (skeleton fallback, container) has no
  // violations, not that the graph itself is accessible. Task 6's DOM
  // outline carries the real a11y contract for the graph.
  it('has no accessibility violations in its own markup', async () => {
    stubFetch()
    stubMatchMedia(false)
    stubCanvasContext()
    const { container } = renderGraphCanvas()

    await screen.findByTestId('graph-canvas')
    await expectNoA11yViolations(container)
  })

  it('tapping a node on the canvas (after panning) expands the same community and updates the outline', async () => {
    // community 0's member fetch, kept distinct from the aggregated fixture
    // so "the outline reflects it" is provable — a real path shows up.
    const memberGraph = {
      nodes: [
        {
          id: 'm1',
          resourceType: 'note',
          resourceId: 'r1',
          path: 'notes/tapped.md',
          type: null,
          tags: [],
          timestamp: null,
          updatedAt: null,
          community: 0,
        },
      ],
      edges: [],
      cappedGroups: [],
      memberTotal: 1,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('community=0')) return Promise.resolve(mockJsonResponse(200, memberGraph))
        return Promise.resolve(mockJsonResponse(200, GRAPH))
      }),
    )
    stubMatchMedia(false)
    stubCanvasContext()
    const raf = stubManualRaf()
    const user = userEvent.setup()

    const { container } = renderGraphCanvas()
    await waitFor(() => expect(raf.pending()).toBeGreaterThan(0))
    const canvas = container.querySelector('canvas')!

    // Never flush a frame: GRAPH's first node (community 0) is index 0 in
    // toSimNodes's golden-angle spiral, which places index 0 at exactly
    // world (0, 0) *before* the simulation ever ticks — the "stubbed
    // simulation position" the task calls for, achieved by simply never
    // letting d3-force move anything.
    expect(raf.pending()).toBeGreaterThan(0)

    // Pan the view 40 CSS px right, driven by real pointer events.
    await user.pointer([
      { keys: '[MouseLeft>]', target: canvas, coords: { clientX: 100, clientY: 100 } },
      { target: canvas, coords: { clientX: 140, clientY: 100 } },
      { keys: '[/MouseLeft]' },
    ])

    // Community 0's node, at world (0, 0), now renders at screen (40, 0).
    // Tapping raw screen (0, 0) — where the node used to be before the pan —
    // must NOT hit it; only the inverse-transformed point does.
    await user.pointer({ keys: '[MouseLeft]', target: canvas, coords: { clientX: 0, clientY: 0 } })
    expect(screen.queryByRole('heading', { name: /members/ })).toBeNull()

    await user.pointer({ keys: '[MouseLeft]', target: canvas, coords: { clientX: 40, clientY: 0 } })

    expect(await screen.findByText('notes/tapped.md')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Community 0/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('the colour-mode toggle redraws with the new mode without re-heating the simulation', async () => {
    stubFetch()
    stubMatchMedia(false)
    stubCanvasContext()
    const raf = stubManualRaf()
    const user = userEvent.setup()
    renderGraphCanvas()

    await waitFor(() => expect(raf.pending()).toBeGreaterThan(0))
    // Run the simulation all the way to idle first, exactly like the
    // "stops drawing" test above — this isolates the toggle's own redraw
    // from the ticks the simulation would produce on its own regardless.
    for (let i = 0; i < 400 && raf.pending() > 0; i++) raf.flush()
    expect(raf.pending()).toBe(0)
    expect(drawGraphSpy).toHaveBeenLastCalledWith('attribute')

    const ticksAtIdle = tickSpy.mock.calls.length
    drawGraphSpy.mockClear()

    await user.click(screen.getByRole('radio', { name: /by community/i }))

    // Idle -> the toggle alone schedules exactly one more frame (the same
    // "idle -> redraw" transition panzoom's own pan/zoom uses), never a
    // re-heat of the simulation.
    expect(raf.pending()).toBeGreaterThan(0)
    raf.flush()

    expect(drawGraphSpy).toHaveBeenCalledWith('community')
    // A toggle that only updates state and never invalidates the canvas
    // would never call drawGraph again at all, and this would still be 0.
    expect(drawGraphSpy).toHaveBeenCalledTimes(1)
    // Proves the redraw did not re-heat: no new ticks came from toggling.
    expect(tickSpy.mock.calls.length).toBe(ticksAtIdle)
  })

  it('renders the error state, never a silently empty canvas, when the graph query fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(500, { error: 'Database unreachable' })))
    stubMatchMedia(false)
    stubCanvasContext()
    renderGraphCanvas()

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load the graph/i)
    expect(screen.getByText('Database unreachable')).toBeInTheDocument()
    // The two-pane canvas layout (and its outline buttons) must never
    // render behind/alongside the error.
    expect(screen.queryByRole('button', { name: /Community/ })).toBeNull()
    expect(document.querySelector('canvas')).toBeNull()
  })

  it('tapping a super-node redraws the canvas with that community\'s real members, not the unchanged aggregate view', async () => {
    const memberGraph = {
      nodes: [
        { id: 'm1', resourceType: 'note', resourceId: 'r1', path: 'notes/a.md', type: 'people', tags: [], timestamp: null, updatedAt: null, community: 0 },
        { id: 'm2', resourceType: 'note', resourceId: 'r1', path: 'notes/b.md', type: 'tasks', tags: [], timestamp: null, updatedAt: null, community: 0 },
      ],
      edges: [],
      cappedGroups: [],
      memberTotal: 2,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(mockJsonResponse(200, url.includes('community=0') ? memberGraph : GRAPH)),
      ),
    )
    stubMatchMedia(false)
    stubCanvasContext()
    const raf = stubManualRaf()
    const user = userEvent.setup()

    const { container } = renderGraphCanvas()
    await waitFor(() => expect(raf.pending()).toBeGreaterThan(0))
    const canvas = container.querySelector('canvas')!

    await user.pointer({ keys: '[MouseLeft]', target: canvas, coords: { clientX: 0, clientY: 0 } })
    await screen.findByText('notes/a.md')

    // The effect rebuild triggered by the member fetch resolving schedules
    // a fresh frame; flushing it draws the new (member) node set.
    await waitFor(() => expect(raf.pending()).toBeGreaterThan(0))
    drawOptsSpy.mockClear()
    raf.flush()

    const lastOpts = drawOptsSpy.mock.calls.at(-1)?.[0]
    // A canvas still showing the unchanged aggregate view would draw
    // GRAPH's 2 community super-nodes (no `type` field at all); the real
    // member nodes carry `type`.
    expect(lastOpts.nodes).toHaveLength(2)
    expect(lastOpts.nodes.map((n: { type?: string }) => n.type).sort()).toEqual(['people', 'tasks'])
  })

  it('the type/tags filter panel populates from a community\'s real members once expanded — not permanently empty', async () => {
    const memberGraph = {
      nodes: [
        { id: 'm1', resourceType: 'note', resourceId: 'r1', path: 'notes/a.md', type: 'people', tags: ['x'], timestamp: null, updatedAt: null, community: 0 },
      ],
      edges: [],
      cappedGroups: [],
      memberTotal: 1,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(mockJsonResponse(200, url.includes('community=0') ? memberGraph : GRAPH)),
      ),
    )
    stubMatchMedia(false)
    stubCanvasContext()
    const raf = stubManualRaf()
    const user = userEvent.setup()

    const { container } = renderGraphCanvas()
    await waitFor(() => expect(raf.pending()).toBeGreaterThan(0))

    // Before any drill-down, the aggregated graph has no per-node
    // type/tags — the Type/Tags fieldsets must not appear.
    expect(screen.queryByText('Type')).toBeNull()

    const canvas = container.querySelector('canvas')!
    await user.pointer({ keys: '[MouseLeft]', target: canvas, coords: { clientX: 0, clientY: 0 } })
    await screen.findByText('notes/a.md')

    expect(await screen.findByText('Type')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'people' })).toBeInTheDocument()
  })

  it('under reduced motion, a physics change after settling re-enters batched settling, not one-tick-per-frame running', async () => {
    stubFetch()
    stubMatchMedia(true)
    stubCanvasContext()
    const raf = stubManualRaf()
    const user = userEvent.setup()
    renderGraphCanvas()

    await waitFor(() => expect(raf.pending()).toBeGreaterThan(0))
    for (let i = 0; i < 50 && raf.pending() > 0; i++) raf.flush()
    expect(raf.pending()).toBe(0) // settled

    tickSpy.mockClear()
    await user.click(screen.getByRole('button', { name: /physics controls/i }))
    const slider = screen.getByRole('slider', { name: /force strength/i })
    fireEvent.change(slider, { target: { value: '-200' } })

    expect(raf.pending()).toBeGreaterThan(0)
    raf.flush()
    // A batched settle re-heat ticks more than once per flushed frame; a
    // re-heat that wrongly drops back into 'running' mode ticks exactly
    // once per flush, which this would also satisfy if it were <= 1 — the
    // strict ">1" is what a one-tick-per-frame regression fails.
    expect(tickSpy.mock.calls.length).toBeGreaterThan(1)
  })

  it('a filter change carries the pan/zoom transform and physics params across the simulation rebuild', async () => {
    stubFetch()
    stubMatchMedia(false)
    stubCanvasContext()
    const raf = stubManualRaf()
    const user = userEvent.setup()
    const { container } = renderGraphCanvas()

    await waitFor(() => expect(raf.pending()).toBeGreaterThan(0))
    const canvas = container.querySelector('canvas')!

    await user.pointer([
      { keys: '[MouseLeft>]', target: canvas, coords: { clientX: 100, clientY: 100 } },
      { target: canvas, coords: { clientX: 150, clientY: 100 } },
      { keys: '[/MouseLeft]' },
    ])

    await user.click(screen.getByRole('button', { name: /physics controls/i }))
    const linkSlider = screen.getByRole('slider', { name: /link distance/i })
    fireEvent.change(linkSlider, { target: { value: '250' } })
    expect(linkSlider).toHaveValue('250')

    drawOptsSpy.mockClear()
    createSimulationParamsSpy.mockClear()

    // A filter change: the same mechanism GraphFilters itself uses (writes
    // to the URL), which changes the `graph` query's key and rebuilds the
    // simulation from scratch.
    fireEvent.change(screen.getByLabelText(/since/i), { target: { value: '2020-01-01' } })

    await waitFor(() => expect(raf.pending()).toBeGreaterThan(0))
    raf.flush()

    // Physics: the rebuilt simulation must be seeded with what the user
    // set — a rebuild seeded from DEFAULT_SIMULATION_PARAMS instead of the
    // ref would show 60 (the default `linkDistance`) here instead of 250.
    expect(createSimulationParamsSpy).toHaveBeenLastCalledWith(expect.objectContaining({ linkDistance: 250 }))

    // Pan/zoom: the rebuilt simulation must still draw with the earlier
    // pan applied, not a fresh identity transform.
    const lastOpts = drawOptsSpy.mock.calls.at(-1)?.[0]
    expect(lastOpts.transform.x).not.toBe(0)
  })
})
