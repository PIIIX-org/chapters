import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Network, ArrowUpRight, ArrowDownLeft, Sparkles } from 'lucide-react'
import { Eyebrow } from '../ui/eyebrow.js'
import { Pill } from '../ui/pill.js'
import { useLocalGraph } from '../../hooks/useLocalGraph.js'
import type { LocalGraphNode } from '../../api/graph.js'

interface LocalGraphPanelProps {
  vaultId: string
  path: string
}

interface NodePosition {
  node: LocalGraphNode
  x: number
  y: number
  radius: number
}

function computeLayout(
  center: LocalGraphNode,
  nodes: LocalGraphNode[],
  width = 300,
  height = 240,
): Map<string, NodePosition> {
  const map = new Map<string, NodePosition>()
  const cx = width / 2
  const cy = height / 2

  // Center node
  map.set(center.id, { node: center, x: cx, y: cy, radius: 15 })

  const oneHopNodes = nodes.filter((n) => !n.isCenter && n.depth === 1)
  const twoHopNodes = nodes.filter((n) => !n.isCenter && n.depth === 2)

  const r1 = 65
  const count1 = oneHopNodes.length
  for (let i = 0; i < count1; i++) {
    const angle = (2 * Math.PI * i) / count1 - Math.PI / 2
    const n = oneHopNodes[i]!
    map.set(n.id, {
      node: n,
      x: cx + r1 * Math.cos(angle),
      y: cy + r1 * Math.sin(angle),
      radius: 10,
    })
  }

  const r2 = 100
  const count2 = twoHopNodes.length
  for (let i = 0; i < count2; i++) {
    const angle = (2 * Math.PI * i) / count2 - Math.PI / 4
    const n = twoHopNodes[i]!
    map.set(n.id, {
      node: n,
      x: cx + r2 * Math.cos(angle),
      y: cy + r2 * Math.sin(angle),
      radius: 7,
    })
  }

  return map
}

export function LocalGraphPanel({ vaultId, path }: LocalGraphPanelProps) {
  const [depth, setDepth] = useState<1 | 2>(1)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const navigate = useNavigate()
  const { data, isPending, isError, error } = useLocalGraph(vaultId, path, depth)

  const center = data?.center
  const nodes = data?.nodes ?? []
  const edges = data?.edges ?? []
  const neighbors = nodes.filter((n) => !n.isCenter)

  const layout = center ? computeLayout(center, nodes) : new Map<string, NodePosition>()

  // Helper to categorize relation for a neighbor relative to center
  function getRelationToCenter(neighborId: string): { label: string; kind: 'outgoing' | 'incoming' | 'semantic' } {
    const outgoing = edges.find((e) => e.source === center?.id && e.target === neighborId && e.kind === 'extracted')
    if (outgoing) return { label: 'Outgoing', kind: 'outgoing' }
    const incoming = edges.find((e) => e.target === center?.id && e.source === neighborId && e.kind === 'extracted')
    if (incoming) return { label: 'Backlink', kind: 'incoming' }
    const semantic = edges.find(
      (e) =>
        e.kind === 'semantic' &&
        ((e.source === center?.id && e.target === neighborId) ||
          (e.target === center?.id && e.source === neighborId)),
    )
    if (semantic) {
      const pct = semantic.similarity ? ` (${Math.round(semantic.similarity * 100)}%)` : ''
      return { label: `Semantic${pct}`, kind: 'semantic' }
    }
    return { label: '2-hop', kind: 'outgoing' }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <Network className="size-3.5 text-primary" aria-hidden="true" />
            <Eyebrow as="h3">Local Graph</Eyebrow>
          </div>
          <p className="text-xs text-muted-foreground">Ego network centered on this note.</p>
        </div>

        {/* Depth toggle */}
        <div
          className="flex items-center rounded-md border border-border bg-muted/30 p-0.5"
          role="group"
          aria-label="Graph depth"
        >
          <button
            type="button"
            onClick={() => setDepth(1)}
            aria-pressed={depth === 1}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              depth === 1
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            1 hop
          </button>
          <button
            type="button"
            onClick={() => setDepth(2)}
            aria-pressed={depth === 2}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              depth === 2
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            2 hops
          </button>
        </div>
      </div>

      {isPending ? (
        <p className="text-sm text-muted-foreground">Loading local graph…</p>
      ) : isError ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : neighbors.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-4 text-center">
          <p className="text-sm text-muted-foreground">No local connections yet.</p>
          <p className="text-xs text-muted-foreground">
            Add <code className="font-mono text-xs">[[wikilinks]]</code> in this note or mention it elsewhere to explore its local knowledge network.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Visual SVG Ego Network */}
          <div className="relative rounded-md border border-border bg-card/60 p-1">
            <svg
              viewBox="0 0 300 240"
              className="h-56 w-full select-none"
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="local-graph-arrow"
                  viewBox="0 0 10 10"
                  refX="18"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="hsl(var(--primary))" opacity="0.8" />
                </marker>
                <marker
                  id="local-graph-arrow-incoming"
                  viewBox="0 0 10 10"
                  refX="18"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="hsl(var(--muted-foreground))" opacity="0.6" />
                </marker>
              </defs>

              {/* Edges */}
              {edges.map((edge) => {
                const s = layout.get(edge.source)
                const t = layout.get(edge.target)
                if (!s || !t) return null

                const isConnectedToCenter = edge.source === center?.id || edge.target === center?.id
                const isHovered =
                  hoveredNodeId && (edge.source === hoveredNodeId || edge.target === hoveredNodeId)
                const isSemantic = edge.kind === 'semantic'
                const isOutgoingFromCenter = edge.source === center?.id

                return (
                  <line
                    key={`${edge.source}-${edge.target}-${edge.kind}`}
                    x1={s.x}
                    y1={s.y}
                    x2={t.x}
                    y2={t.y}
                    stroke={
                      isSemantic
                        ? 'hsl(180 70% 45%)'
                        : isConnectedToCenter
                          ? isOutgoingFromCenter
                            ? 'hsl(var(--primary))'
                            : 'hsl(var(--muted-foreground))'
                          : 'hsl(var(--border))'
                    }
                    strokeWidth={isHovered ? 2.5 : isConnectedToCenter ? 1.5 : 1}
                    strokeOpacity={isHovered ? 1 : isConnectedToCenter ? 0.75 : 0.35}
                    strokeDasharray={isSemantic ? '4 3' : isOutgoingFromCenter ? undefined : '3 2'}
                    markerEnd={
                      !isSemantic
                        ? isOutgoingFromCenter
                          ? 'url(#local-graph-arrow)'
                          : 'url(#local-graph-arrow-incoming)'
                        : undefined
                    }
                  />
                )
              })}

              {/* Center Node Ring (Accent / Focus) */}
              {center && layout.get(center.id) && (
                <circle
                  cx={layout.get(center.id)!.x}
                  cy={layout.get(center.id)!.y}
                  r={21}
                  fill="none"
                  stroke="hsl(var(--primary))"
                  strokeWidth="1.5"
                  strokeDasharray="4 2"
                  className="animate-pulse"
                />
              )}

              {/* Nodes */}
              {[...layout.values()].map(({ node, x, y, radius }) => {
                const isCenter = node.isCenter
                const isHovered = hoveredNodeId === node.id

                return (
                  <g
                    key={node.id}
                    className={isCenter ? 'cursor-default' : 'cursor-pointer'}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                    onMouseLeave={() => setHoveredNodeId(null)}
                    onClick={() => {
                      if (!isCenter) navigate(`/vaults/${vaultId}/notes/${node.path}`)
                    }}
                  >
                    <circle
                      cx={x}
                      cy={y}
                      r={isHovered ? radius + 3 : radius}
                      fill={isCenter ? 'hsl(var(--primary))' : 'hsl(var(--card))'}
                      stroke={
                        isCenter
                          ? 'hsl(var(--primary-foreground))'
                          : isHovered
                            ? 'hsl(var(--primary))'
                            : 'hsl(var(--border))'
                      }
                      strokeWidth={isCenter || isHovered ? 2 : 1.5}
                      className="transition-all duration-150"
                    />
                    <text
                      x={x}
                      y={y + radius + 11}
                      textAnchor="middle"
                      className={`text-[9px] font-sans ${
                        isCenter
                          ? 'font-bold fill-foreground'
                          : isHovered
                            ? 'font-semibold fill-primary'
                            : 'fill-muted-foreground'
                      }`}
                    >
                      {(node.title || node.name).slice(0, 14)}
                    </text>
                  </g>
                )
              })}
            </svg>

            {/* Hover tooltip overlay */}
            {hoveredNodeId && (
              <div className="pointer-events-none absolute bottom-2 left-2 right-2 rounded bg-popover/90 px-2 py-1 text-[11px] text-popover-foreground shadow backdrop-blur-sm">
                <span className="font-semibold">
                  {nodes.find((n) => n.id === hoveredNodeId)?.title ||
                    nodes.find((n) => n.id === hoveredNodeId)?.name}
                </span>
                <span className="ml-1 text-muted-foreground">
                  ({nodes.find((n) => n.id === hoveredNodeId)?.path})
                </span>
              </div>
            )}
          </div>

          {/* Connection List */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Connections ({neighbors.length})
            </span>
            <ul className="flex flex-col gap-1.5" aria-label="Connected notes">
              {neighbors.map((neighbor) => {
                const relation = getRelationToCenter(neighbor.id)
                return (
                  <li key={neighbor.id}>
                    <Link
                      to={`/vaults/${vaultId}/notes/${neighbor.path}`}
                      className="group flex flex-col gap-1 rounded-md border border-border bg-card p-2 transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {relation.kind === 'outgoing' ? (
                            <ArrowUpRight
                              className="size-3.5 shrink-0 text-primary"
                              aria-hidden="true"
                            />
                          ) : relation.kind === 'incoming' ? (
                            <ArrowDownLeft
                              className="size-3.5 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          ) : (
                            <Sparkles
                              className="size-3.5 shrink-0 text-teal-500"
                              aria-hidden="true"
                            />
                          )}
                          <span className="truncate text-xs font-medium text-foreground group-hover:text-primary">
                            {neighbor.title || neighbor.name}
                          </span>
                        </div>
                        <Pill
                          tone={
                            relation.kind === 'outgoing'
                              ? 'human'
                              : relation.kind === 'semantic'
                                ? 'ai'
                                : 'neutral'
                          }
                          className="shrink-0 text-[10px] font-mono"
                        >
                          {relation.label}
                        </Pill>
                      </div>
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {neighbor.path}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </section>
  )
}
