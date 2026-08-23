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

interface GraphErrorStateProps {
  message?: string
  onRetry: () => void
}

/** A failed graph request — visibly distinct from an empty graph, never a blank canvas. */
export function GraphErrorState({ message, onRetry }: GraphErrorStateProps) {
  return (
    <div
      role="alert"
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background px-4 text-center"
    >
      <h2 className="font-display text-xl text-foreground">We couldn&rsquo;t load the graph.</h2>
      {message && <p className="max-w-sm text-sm text-muted-foreground">{message}</p>}
      <Button type="button" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

interface GraphEmptyStateProps {
  createNoteHref: string
}

/** A successful fetch with zero nodes — an empty graph is not an error. */
export function GraphEmptyState({ createNoteHref }: GraphEmptyStateProps) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background px-4 text-center">
      <h2 className="font-display text-xl text-foreground">Nothing to draw yet</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        The graph draws the links between your notes — write one to see it grow.
      </p>
      <Button asChild>
        <Link to={createNoteHref}>Create a note</Link>
      </Button>
    </div>
  )
}

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
    <div role="status" className="max-w-sm rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm">
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
    <div role="status" className="max-w-sm rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm">
      Showing {shown.toLocaleString()} of {total.toLocaleString()} notes in this community
    </div>
  )
}
