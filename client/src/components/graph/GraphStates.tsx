// The graph's non-canvas states: failed fetch, an empty successful result,
// and two non-blocking "we capped this" notices. Deliberately decoupled
// from react-query and the graph API types — every piece here takes plain
// primitives, so GraphCanvas (and GraphStates.test.tsx, driving a real
// useGraph query) each compute what they need and pass it in. See unit 1c
// task 10 and the standing rule against a test that cannot fail: the retry
// button below calls a caller-supplied `onRetry`, never local state, so a
// button that only re-renders without refetching fails its test.
import { Link } from 'react-router'
import { Button } from '../ui/button.js'
import { PanelState } from '../ui/empty-state.js'

interface GraphErrorStateProps {
  message?: string
  onRetry: () => void
}

/** A failed graph request — visibly distinct from an empty graph, never a blank canvas. */
export function GraphErrorState({ message, onRetry }: GraphErrorStateProps) {
  return (
    <PanelState
      status="error"
      title="We couldn’t load the graph."
      message={message}
      onRetry={onRetry}
      className="h-full"
    />
  )
}

interface GraphEmptyStateProps {
  createNoteHref: string
}

/** A successful fetch with zero nodes — an empty graph is not an error. */
export function GraphEmptyState({ createNoteHref }: GraphEmptyStateProps) {
  return (
    <PanelState
      status="empty"
      title="Nothing to draw yet"
      message="The graph draws the links between your notes — write one to see it grow."
      action={
        <Button asChild>
          <Link to={createNoteHref}>Create a note</Link>
        </Button>
      }
      className="h-full"
    />
  )
}

// Both notices sit in the canvas cell's bottom-left corner: small, bordered,
// popover-toned so they read as instrumentation over the canvas — never a
// floating card with its own shadow (shadows are for menus/dialogs only).
const NOTICE_CLASS =
  'max-w-sm rounded-md border border-border bg-popover/90 px-2.5 py-1.5 text-xs text-muted-foreground'

interface CappedGroupsNoticeProps {
  groups: string[]
}

/**
 * The server refuses to build pairwise edges for oversized structural
 * groups rather than silently truncating (`assemble.ts`) — this names what
 * was skipped instead of letting the graph just look thinner than it is.
 * Non-blocking: renders alongside a graph that otherwise loaded fine.
 */
export function CappedGroupsNotice({ groups }: CappedGroupsNoticeProps) {
  if (groups.length === 0) return null
  return (
    <div role="status" className={NOTICE_CLASS}>
      Too large to link pairwise, so edges were skipped for: {groups.join(', ')}
    </div>
  )
}

interface TruncationNoticeProps {
  shown: number
  total: number
}

/** A drill-down cap, stated rather than silent — "showing N of M". */
export function TruncationNotice({ shown, total }: TruncationNoticeProps) {
  if (total <= shown) return null
  return (
    <div role="status" className={NOTICE_CLASS}>
      Showing {shown.toLocaleString()} of {total.toLocaleString()} notes in this community
    </div>
  )
}
