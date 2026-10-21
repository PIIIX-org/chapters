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
 * - `offline` / `reconnecting` — we cannot reach the relay. Nothing was taken
 *   away; the text is sitting in this browser, not on the server.
 * - `revoked` — access was pulled. Coming back will not help.
 * - `signed-out` — the session ended (logout, possibly in another tab). The
 *   note stopped syncing until the person logs in again (#498).
 *
 * Saying "disconnected" for both is what makes a person close the tab on a
 * revocation and lose what they typed.
 *
 * A dropped socket says "Offline — not saved yet" from the moment it drops
 * (#720): "Syncing…" over a dead connection reads as progress, and the
 * person keeps typing into text that is going nowhere.
 */
const WHISPER: Record<
  Exclude<CollabStatus, 'connected'>,
  { tone: PillTone; label: string; detail: string | null }
> = {
  connecting: { tone: 'idle', label: 'Connecting…', detail: null },
  reconnecting: { tone: 'error', label: 'Offline', detail: 'not saved yet' },
  offline: { tone: 'error', label: 'Offline', detail: 'your edits are staying in this tab' },
  revoked: { tone: 'error', label: 'Access removed', detail: 'this note stopped syncing' },
  'signed-out': { tone: 'error', label: 'Signed out', detail: 'log in again to keep editing' },
  'too-large': { tone: 'error', label: 'Too large', detail: 'not saved — shorten the note' },
  'not-migrated': { tone: 'error', label: 'Waiting for migration', detail: 'an admin needs to restart the server' },
  'reload-required': { tone: 'error', label: 'Reload to keep editing', detail: 'the server was updated' },
  deleted: { tone: 'error', label: 'Deleted', detail: 'this note is in the trash' },
  paused: { tone: 'error', label: 'Saving paused', detail: 'your edits are staying in this tab' },
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
        <Pill tone={synced ? 'live' : 'idle'} dot className="hidden sm:inline-flex">
          {synced ? 'Synced' : 'Syncing…'}
        </Pill>
        {synced && syncedAt && (
          <time
            className="font-mono text-xs tabular-nums text-muted-foreground"
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
      <Pill tone={whisper.tone} dot className="hidden sm:inline-flex">
        {whisper.label}
      </Pill>
      {whisper.detail && (
        <span className="truncate font-mono text-xs tabular-nums text-muted-foreground">
          {whisper.detail}
          {/* What the server holds is the text as of the last sync. */}
          {status === 'reconnecting' && syncedAt && (
            <>
              {' · last synced '}
              <time dateTime={syncedAt.toISOString()}>
                {syncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
            </>
          )}
        </span>
      )}
    </span>
  )
}
