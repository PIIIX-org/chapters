// The inspector's view of one community: the hovered or expanded
// community's stats, and — once expanded — its real member list. Split out
// of GraphOutline by the command redesign: the outline (context panel) is
// navigation, this (inspector) is detail. Expansion state still lives in
// GraphCanvas, exactly as before, so a canvas tap, a keyboard Enter in the
// outline and the back button here all converge on the same state.
import { useEffect, useRef } from 'react'
import { useGraph } from '../../hooks/useGraph.js'
import type { CommunityNode, GraphFilters, VaultGraph } from '../../api/graph.js'
import { Button } from '../ui/button.js'
import { Panel, PanelBody, PanelHeader } from '../ui/panel.js'
import { Eyebrow } from '../ui/eyebrow.js'
import { countWithNoun, formatLastActive } from './GraphOutline.js'

const NO_FILTERS: GraphFilters = {}

export interface CommunityDetailProps {
  communities: CommunityNode[]
  /** Community under the cursor on the canvas — shown when nothing is expanded. */
  hoveredCommunity: number | null
  expandedCommunity: number | null
  onCollapse: () => void
  filters?: GraphFilters
}

export function CommunityDetail({
  communities,
  hoveredCommunity,
  expandedCommunity,
  onCollapse,
  filters = NO_FILTERS,
}: CommunityDetailProps) {
  // Expanded wins over hovered: while drilled in, sweeping the cursor over
  // the member nodes must not flip the detail away from the drill-down.
  const active = expandedCommunity ?? hoveredCommunity
  const node = communities.find((c) => c.community === active)

  // Cache-shared with GraphCanvas's own drill-down query (react-query
  // hashes by content) — a hit while expanded, and while collapsed this
  // resolves to the aggregated query the canvas already holds.
  const memberQuery = useGraph(expandedCommunity, filters)
  const memberData = expandedCommunity !== null ? (memberQuery.data as VaultGraph | undefined) : undefined

  // Move focus onto the members heading on every expand transition,
  // whether it came from a canvas tap or a keyboard Enter in the outline.
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previousExpandedRef = useRef<number | null>(null)
  useEffect(() => {
    if (expandedCommunity !== null && expandedCommunity !== previousExpandedRef.current) {
      headingRef.current?.focus()
    }
    previousExpandedRef.current = expandedCommunity
  }, [expandedCommunity])

  const liveMessage =
    expandedCommunity !== null && memberData
      ? `Expanded community ${expandedCommunity}, showing ${memberData.nodes.length.toLocaleString()} of ${(memberData.memberTotal ?? memberData.nodes.length).toLocaleString()}.`
      : ''

  return (
    <Panel>
      <PanelHeader
        title={active === null ? 'Community' : `Community ${active}`}
        titleAs="h3"
        actions={
          expandedCommunity !== null && (
            <Button type="button" variant="outline" size="xs" onClick={onCollapse}>
              Back to all communities
            </Button>
          )
        }
      />
      <PanelBody className="flex flex-col gap-3">
        {active === null || !node ? (
          <p className="text-xs text-muted-foreground">
            Hover a node on the canvas, or expand a community in the outline, to inspect it.
          </p>
        ) : (
          <>
            <dl className="flex flex-col gap-1 text-[13px] text-foreground">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">Notes</dt>
                <dd className="font-mono tabular-nums">{node.noteCount.toLocaleString()}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">Code files</dt>
                <dd className="font-mono tabular-nums">{node.codeCount.toLocaleString()}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">Members</dt>
                <dd className="font-mono tabular-nums">{node.size.toLocaleString()}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">Activity</dt>
                <dd className="text-right">{formatLastActive(node.lastActivity)}</dd>
              </div>
            </dl>

            {expandedCommunity !== null && (
              <section aria-labelledby="community-detail-members-heading" className="flex flex-col gap-2 border-t border-border pt-3">
                <h3 id="community-detail-members-heading" ref={headingRef} tabIndex={-1}>
                  <Eyebrow>{`Community ${expandedCommunity} members`}</Eyebrow>
                </h3>
                {memberQuery.isPending && <p className="text-sm text-muted-foreground">Loading members…</p>}
                {memberQuery.isError && (
                  <p className="text-sm text-destructive">Could not load this community's members.</p>
                )}
                {memberData && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {`Showing ${countWithNoun(memberData.nodes.length, 'member')} of ${(memberData.memberTotal ?? memberData.nodes.length).toLocaleString()}.`}
                    </p>
                    <ul className="flex flex-col gap-0.5 font-mono text-xs text-foreground">
                      {memberData.nodes.map((n) => (
                        <li key={n.id} className="truncate" title={n.path}>
                          {n.path}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            )}
          </>
        )}
      </PanelBody>
      <div role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </div>
    </Panel>
  )
}
