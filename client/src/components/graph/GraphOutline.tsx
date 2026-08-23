// The real, keyboard-operable interface to the graph. The canvas next to
// this is `aria-hidden` presentation with zero accessible content of its
// own (a bare canvas passes axe happily either way) — this list is what
// assistive tech actually gets. See the unit 1c task 6 notes.
//
// Expansion state (`expandedCommunity`) is owned by the parent (GraphCanvas)
// so a canvas tap and a keyboard Enter on a community button converge on the
// exact same state instead of drifting into two copies of "which community
// is open".
import { useEffect, useRef, useState } from 'react'
import { useGraph } from '../../hooks/useGraph.js'
import type { CommunityNode, GraphFilters, VaultGraph } from '../../api/graph.js'
import { Button } from '../ui/button.js'
import { buttonVariants } from '../ui/button-variants.js'
import { cn } from '../../lib/utils.js'

// Falls back to unfiltered when the caller doesn't pass filters (e.g. an
// older test harness) — task 9's real caller (GraphCanvas) always does, so
// the member fetch stays in lockstep with whatever's set in the URL.
const NO_FILTERS: GraphFilters = {}

const lastActiveFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

function formatLastActive(iso: string | null): string {
  if (!iso) return 'no recorded activity'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return 'no recorded activity'
  return `last active ${lastActiveFormatter.format(parsed)}`
}

function countWithNoun(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`
}

function communityLabel(c: CommunityNode): string {
  return `Community ${c.community} — ${countWithNoun(c.noteCount, 'note')}, ${countWithNoun(c.codeCount, 'code file')}, ${formatLastActive(c.lastActivity)}`
}

interface GraphOutlineProps {
  communities: CommunityNode[]
  expandedCommunity: number | null
  onExpand: (community: number) => void
  onCollapse: () => void
  /**
   * Task 9: the same type/tags/since/until filters applied to the
   * aggregated Home view apply here too — changing a filter while a
   * community is expanded must keep `community=<n>` in this request
   * rather than silently dropping the filter or bouncing back to
   * aggregated. Optional so an older caller (or test harness) that hasn't
   * been updated still gets the previous unfiltered behaviour.
   */
  filters?: GraphFilters
}

export function GraphOutline({ communities, expandedCommunity, onExpand, onCollapse, filters = NO_FILTERS }: GraphOutlineProps) {
  const buttonRefs = useRef(new Map<number, HTMLButtonElement>())
  const membersHeadingRef = useRef<HTMLHeadingElement>(null)
  const previousExpandedRef = useRef<number | null>(null)
  const [announcement, setAnnouncement] = useState('')

  // Fetching is fine to run unconditionally here: when `expandedCommunity`
  // is null this resolves to the same `aggregate=community` queryKey
  // GraphCanvas already fetches (react-query hashes by content), so it's a
  // cache hit, not a second request. When it's a community number, this is
  // the real member fetch the task requires.
  const memberQuery = useGraph(expandedCommunity, filters)
  const memberData = expandedCommunity !== null ? (memberQuery.data as VaultGraph | undefined) : undefined

  // Move focus on every expand/collapse transition, regardless of whether it
  // was a keyboard Enter on a community button or a canvas tap driving the
  // same `onExpand`/`onCollapse` handlers.
  useEffect(() => {
    const previous = previousExpandedRef.current
    if (expandedCommunity !== null && expandedCommunity !== previous) {
      membersHeadingRef.current?.focus()
    } else if (expandedCommunity === null && previous !== null) {
      buttonRefs.current.get(previous)?.focus()
      setAnnouncement('Returned to all communities.')
    }
    previousExpandedRef.current = expandedCommunity
  }, [expandedCommunity])

  // Derived at render time, not via a second effect+setState: once the
  // member fetch resolves, this is what the live region shows. Until then
  // (or once collapsed), `announcement` — set only by the effect above,
  // alongside the imperative focus move it already has to make — carries
  // the last transition's message instead.
  const liveMessage =
    expandedCommunity !== null && memberData
      ? `Expanded community ${expandedCommunity}, showing ${memberData.nodes.length.toLocaleString()} of ${(memberData.memberTotal ?? memberData.nodes.length).toLocaleString()}.`
      : announcement

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <h2 className="font-display text-lg text-foreground">Communities</h2>
      <ul className="flex flex-col gap-1">
        {communities.map((c) => (
          <li key={c.community}>
            <button
              ref={(el) => {
                if (el) buttonRefs.current.set(c.community, el)
                else buttonRefs.current.delete(c.community)
              }}
              type="button"
              aria-expanded={expandedCommunity === c.community}
              onClick={() => onExpand(c.community)}
              className={cn(
                buttonVariants({ variant: 'ghost' }),
                'h-auto w-full justify-start whitespace-normal px-3 py-2 text-left',
              )}
            >
              {communityLabel(c)}
            </button>
          </li>
        ))}
      </ul>

      {expandedCommunity !== null && (
        <section
          aria-labelledby="graph-outline-members-heading"
          className="flex flex-col gap-2 border-t border-border pt-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h3
              id="graph-outline-members-heading"
              ref={membersHeadingRef}
              tabIndex={-1}
              className="font-display text-base text-foreground"
            >
              Community {expandedCommunity} members
            </h3>
            <Button type="button" variant="outline" size="sm" onClick={onCollapse}>
              Back to all communities
            </Button>
          </div>
          {memberQuery.isPending && <p className="text-sm text-muted-foreground">Loading members…</p>}
          {memberQuery.isError && (
            <p className="text-sm text-destructive">Could not load this community's members.</p>
          )}
          {memberData && (
            <ul className="flex flex-col gap-0.5 font-mono text-sm text-foreground">
              {memberData.nodes.map((n) => (
                <li key={n.id} className="truncate" title={n.path}>
                  {n.path}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </div>
    </div>
  )
}
