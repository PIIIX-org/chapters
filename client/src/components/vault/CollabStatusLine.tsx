import type { CollabStatus } from '../../hooks/useCollabDoc.js'
import type { ShellStatus } from '../shell/shell-context.js'
import { Pill } from '../ui/pill.js'
import type { PillTone } from '../ui/pill.js'

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
const WHISPER: Record<
  Exclude<CollabStatus, 'connected'>,
  { tone: PillTone; label: string; detail: string | null }
> = {
  connecting: { tone: 'idle', label: 'Connecting…', detail: null },
  reconnecting: { tone: 'idle', label: 'Reconnecting', detail: 'edits keep merging in this tab' },
  offline: { tone: 'error', label: 'Offline', detail: 'your edits are staying in this tab' },
  revoked: { tone: 'error', label: 'Access removed', detail: 'this note stopped syncing' },
}

/**
 * The same words and tones, shaped for the shell's top-bar pill — one mapping,
 * so the mirror can never disagree with the note bar it mirrors.
 */
export function collabShellStatus(status: CollabStatus, synced: boolean): ShellStatus {
  if (status === 'connected') {
    return synced ? { tone: 'live', label: 'Synced' } : { tone: 'idle', label: 'Syncing…' }
  }
  const { tone, label } = WHISPER[status]
  return { tone, label }
}

/**
 * The autosave whisper, now a status pill in the note bar (and mirrored into
 * the shell's top bar by NoteView): never a modal, never a toast
 * (`docs/superpowers/specs/2026-07-19-ui-design-system.md`).
 *
 * The word is **"Synced"**, never "Saved". The relay's write to disk is
 * debounced and unacknowledged, so a disk write is not something this client
 * has any evidence of (unit 6 plan, gap 4).
 *
 * Tones are semantic status (live/idle/error), never the AI accent — a sync
 * state is not an authorship signal.
 */
export function CollabStatusLine({ status, synced, syncedAt }: CollabStatusLineProps) {
  if (status === 'connected') {
    return (
      <span role="status" className="flex min-w-0 items-center gap-2">
        <Pill tone={synced ? 'live' : 'idle'} dot>
          {synced ? 'Synced' : 'Syncing…'}
        </Pill>
        {synced && syncedAt && (
          <time
            className="font-mono text-xs text-muted-foreground"
            dateTime={syncedAt.toISOString()}
          >
            {syncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
        )}
      </span>
    )
  }

  const whisper = WHISPER[status]
  return (
    <span role="status" className="flex min-w-0 items-center gap-2">
      <Pill tone={whisper.tone} dot>
        {whisper.label}
      </Pill>
      {whisper.detail && (
        <span className="truncate text-xs text-muted-foreground">{whisper.detail}</span>
      )}
    </span>
  )
}
