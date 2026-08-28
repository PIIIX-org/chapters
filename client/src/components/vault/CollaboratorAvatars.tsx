import type { CSSProperties } from 'react'
import type { CollabPeer } from '../../hooks/useCollabDoc.js'

/** Past this many, the row starts crowding the breadcrumb it sits in. */
const MAX_SHOWN = 4

/**
 * One or two letters from a presence label. Until unit 4 gives users a display
 * name, that label is the local part of an email (unit 6 plan, gap 7), so
 * `ada.lovelace` has to read as AL and `b7` as B7.
 */
function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0]!
  const second = words.length > 1 ? words[1]![0]! : (first[1] ?? '')
  return (first[0]! + second).toUpperCase()
}

interface CollaboratorAvatarsProps {
  /** Everyone else in this document, from `useCollabDoc`. Never the local user. */
  peers: CollabPeer[]
}

/**
 * Who else is in this note, right now — in the Editor top bar and nowhere else.
 * There is deliberately no global "who's online": that is a different product's
 * feature and it leaks who is working on what
 * (`docs/superpowers/specs/2026-07-19-ui-design-system.md`).
 *
 * Each avatar wears the peer's own ink, the same hue as their pen nib in the
 * text, so the cursor and the face are recognisably one person. Every face here
 * is a person's: MCP writes through a server-side connection that never joins
 * awareness, so no AI participant can appear in this row at all — and no ink in
 * the human palette is teal. Each is still named in letters as well as hued,
 * because colour alone is not a label.
 */
export function CollaboratorAvatars({ peers }: CollaboratorAvatarsProps) {
  // Alone in the note is the normal case. It gets no chrome at all.
  if (peers.length === 0) return null

  const shown = peers.slice(0, MAX_SHOWN)
  const hidden = peers.length - shown.length

  return (
    <ul aria-label="In this note now" className="flex items-center gap-1">
      {shown.map((peer) => (
        <li
          key={peer.clientId}
          title={peer.name}
          aria-label={`${peer.name} is editing this note`}
          // The ink is a theme-resolved variable, so the peer's identity goes in
          // as a custom property and the paint stays in one static class list.
          style={{ '--ink': peer.ink.color, '--ink-wash': peer.ink.colorLight } as CSSProperties}
          className="flex h-6 w-6 items-center justify-center rounded-full border border-[color:var(--ink)] bg-[color:var(--ink-wash)] text-xs font-medium tracking-wide text-[color:var(--ink)] uppercase"
        >
          {initials(peer.name)}
        </li>
      ))}
      {hidden > 0 && (
        <li
          aria-label={`${hidden} more editing this note`}
          className="flex h-6 items-center rounded-full border border-border bg-muted px-1.5 text-xs font-medium text-muted-foreground"
        >
          +{hidden}
        </li>
      )}
    </ul>
  )
}
