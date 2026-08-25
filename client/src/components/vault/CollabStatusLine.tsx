import type { CollabStatus } from '../../hooks/useCollabDoc.js'

interface CollabStatusLineProps {
  status: CollabStatus
  /** From `useCollabDoc`: handshake done and nothing local still unsent. */
  synced: boolean
  /** When `synced` last became true; null before the first sync of this mount. */
  syncedAt: Date | null
}

/**
 * The word for each state a keystroke can be in. Two of these are easy to
 * confuse and must never read alike:
 *
 * - `offline` — we could not reach the relay. Nothing was taken away; the text
 *   is simply sitting in this tab.
 * - `revoked` — access was pulled. Coming back will not help.
 *
 * Saying "disconnected" for both is what makes a person close the tab on a
 * revocation and lose what they typed.
 */
const WHISPER: Record<Exclude<CollabStatus, 'connected'>, string> = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting — edits keep merging in this tab',
  offline: 'Offline — your edits are staying in this tab',
  revoked: 'Access removed — this note stopped syncing',
}

/**
 * The autosave whisper, in the breadcrumb and nowhere else: never a modal,
 * never a toast (`docs/superpowers/specs/2026-07-19-ui-design-system.md`).
 *
 * The word is **"Synced"**, never "Saved". The relay's write to disk is
 * debounced and unacknowledged, so a disk write is not something this client
 * has any evidence of (unit 6 plan, gap 4).
 */
export function CollabStatusLine({ status, synced, syncedAt }: CollabStatusLineProps) {
  if (status === 'connected') {
    return (
      <span role="status" className="text-xs text-muted-foreground">
        {synced ? 'Synced' : 'Syncing…'}
        {synced && syncedAt && (
          <>
            {' '}
            <time className="font-mono" dateTime={syncedAt.toISOString()}>
              {syncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          </>
        )}
      </span>
    )
  }

  return (
    <span role="status" className="text-xs text-muted-foreground">
      {WHISPER[status]}
    </span>
  )
}
