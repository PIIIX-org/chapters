import { useId, useState } from 'react'
import { Link } from 'react-router'
import { ArrowDown, ArrowUpDown, Route } from 'lucide-react'
import { findShortestPath, type GraphEdge, type GraphNode, type PathFindingResult } from '../../api/graph.js'
import { Button } from '../ui/button.js'

export interface GraphPathfinderProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  onPathChange?: (result: PathFindingResult | null) => void
}

export function GraphPathfinder({ nodes, edges, onPathChange }: GraphPathfinderProps) {
  const sourceSelectId = useId()
  const targetSelectId = useId()
  const [sourceId, setSourceId] = useState<string>('')
  const [targetId, setTargetId] = useState<string>('')
  const [result, setResult] = useState<PathFindingResult | null>(null)
  const [hasSearched, setHasSearched] = useState(false)

  const sortedNodes = [...nodes].sort((a, b) => a.path.localeCompare(b.path))

  const handleFindPath = () => {
    if (!sourceId || !targetId) return
    const res = findShortestPath(nodes, edges, sourceId, targetId)
    setResult(res)
    setHasSearched(true)
    onPathChange?.(res)
  }

  const handleSwap = () => {
    const temp = sourceId
    setSourceId(targetId)
    setTargetId(temp)
    if (hasSearched && targetId && temp) {
      const res = findShortestPath(nodes, edges, targetId, temp)
      setResult(res)
      onPathChange?.(res)
    }
  }

  const handleClear = () => {
    setResult(null)
    setHasSearched(false)
    onPathChange?.(null)
  }

  const edgeLabel = (kind?: GraphEdge['kind']) => {
    switch (kind) {
      case 'extracted':
        return 'wikilink'
      case 'structural':
        return 'hierarchy'
      case 'semantic':
        return 'semantic similarity'
      default:
        return 'connected'
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-2">
        <div>
          <label htmlFor={sourceSelectId} className="block text-xs font-medium text-muted-foreground pb-1">
            Start concept
          </label>
          <select
            id={sourceSelectId}
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">Select source note or file…</option>
            {sortedNodes.map((n) => (
              <option key={n.id} value={n.id}>
                [{n.resourceType}] {n.path}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between px-1">
          <Button
            size="xs"
            variant="ghost"
            type="button"
            className="h-6 gap-1 text-[11px] text-muted-foreground"
            onClick={handleSwap}
            disabled={!sourceId && !targetId}
            aria-label="Swap start and target concepts"
          >
            <ArrowUpDown className="h-3 w-3" />
            <span>Swap</span>
          </Button>
        </div>

        <div>
          <label htmlFor={targetSelectId} className="block text-xs font-medium text-muted-foreground pb-1">
            Target concept
          </label>
          <select
            id={targetSelectId}
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">Select target note or file…</option>
            {sortedNodes.map((n) => (
              <option key={n.id} value={n.id}>
                [{n.resourceType}] {n.path}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="secondary"
            className="w-full gap-1.5 rounded"
            onClick={handleFindPath}
            disabled={!sourceId || !targetId || sourceId === targetId}
          >
            <Route className="h-3.5 w-3.5" />
            <span>Find shortest path</span>
          </Button>
          {hasSearched && (
            <Button size="sm" variant="ghost" onClick={handleClear} className="rounded">
              Reset
            </Button>
          )}
        </div>
      </div>

      {hasSearched && result && (
        <div className="mt-1 flex flex-col gap-2 border-t border-border pt-2">
          {result.found ? (
            <>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {result.distance === 0 ? 'Same concept' : `${result.distance} hop${result.distance === 1 ? '' : 's'}`}
                </span>
                <span>{result.nodes.length} nodes traversed</span>
              </div>

              <ol className="flex flex-col gap-1 text-xs" aria-label="Path steps">
                {result.nodes.map((node, i) => {
                  const connectingEdge = i < result.edges.length ? result.edges[i] : null
                  const linkTarget =
                    node.resourceType === 'note'
                      ? `/vaults/${node.resourceId}/notes/${node.path}`
                      : `/repos/${node.resourceId}/files/${node.path}`

                  return (
                    <li key={node.id} className="flex flex-col">
                      <div className="flex items-center gap-2 rounded bg-muted/30 px-2 py-1.5">
                        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                          {i + 1}
                        </span>
                        <Link
                          to={linkTarget}
                          className="truncate font-medium text-foreground hover:underline"
                          title={node.path}
                        >
                          {node.path}
                        </Link>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground uppercase">
                          {node.resourceType}
                        </span>
                      </div>

                      {connectingEdge && (
                        <div className="flex items-center gap-1.5 py-1 pl-4 text-[10px] text-muted-foreground">
                          <ArrowDown className="h-3 w-3 shrink-0 text-primary" />
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                            {edgeLabel(connectingEdge.kind)}
                          </span>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>
            </>
          ) : (
            <p className="rounded bg-muted/40 p-2.5 text-xs text-muted-foreground">
              No connecting path exists between these two concepts in the current graph view.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
