// The real, keyboard-operable interface to the graph. The canvas next to
// this is `aria-hidden` presentation with zero accessible content of its
// own (a bare canvas passes axe happily either way) — this list is what
// assistive tech actually gets. See the unit 1c task 6 notes.
//
// Since the command redesign this is the context panel's navigation only:
// communities ranked by size, expand/collapse. The expanded community's
// detail and member list live in CommunityDetail (the inspector).
//
// Expansion state (`expandedCommunity`) is owned by the parent (GraphCanvas)
// so a canvas tap and a keyboard Enter on a community button converge on the
// exact same state instead of drifting into two copies of "which community
// is open".
import { useEffect, useRef, useState } from 'react'
import type { CommunityNode } from '../../api/graph.js'
import { buttonVariants } from '../ui/button-variants.js'
import { Eyebrow } from '../ui/eyebrow.js'
import { cn } from '../../lib/utils.js'

const lastActiveFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

export function formatLastActive(iso: string | null): string {
  if (!iso) return 'no recorded activity'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return 'no recorded activity'
  return `last active ${lastActiveFormatter.format(parsed)}`
}

export function countWithNoun(n: number, noun: string): string {
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
}

export function GraphOutline({ communities, expandedCommunity, onExpand, onCollapse }: GraphOutlineProps) {
  const buttonRefs = useRef(new Map<number, HTMLButtonElement>())
  const previousExpandedRef = useRef<number | null>(null)
  const [announcement, setAnnouncement] = useState('')

  // Return focus to the button that opened a community when it collapses,
  // whether the collapse came from this list, the inspector's back button
  // or a canvas gesture.
  useEffect(() => {
    const previous = previousExpandedRef.current
    if (expandedCommunity === null && previous !== null) {
      buttonRefs.current.get(previous)?.focus()
      setAnnouncement('Returned to all communities.')
    }
    previousExpandedRef.current = expandedCommunity
  }, [expandedCommunity])

  // Ranked by size, largest first (spec: "communities ranked by size").
  const ranked = [...communities].sort((a, b) => b.size - a.size)

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <Eyebrow as="h2">Communities</Eyebrow>
      <ul className="flex flex-col gap-1">
        {ranked.map((c) => (
          <li key={c.community}>
            <button
              ref={(el) => {
                if (el) buttonRefs.current.set(c.community, el)
                else buttonRefs.current.delete(c.community)
              }}
              type="button"
              aria-expanded={expandedCommunity === c.community}
              onClick={() => (expandedCommunity === c.community ? onCollapse() : onExpand(c.community))}
              className={cn(
                buttonVariants({ variant: 'ghost' }),
                'h-auto w-full justify-start whitespace-normal px-3 py-2 text-left',
                expandedCommunity === c.community && 'bg-muted',
              )}
            >
              {communityLabel(c)}
            </button>
          </li>
        ))}
      </ul>

      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
