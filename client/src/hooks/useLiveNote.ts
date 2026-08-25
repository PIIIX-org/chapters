import { useEffect, useRef, useState } from 'react'
import { liveNoteUrl } from '../api/collab.js'
import type { LiveNoteState } from '../api/collab.js'

export type LiveStatus =
  /** Opening the stream; nothing has arrived yet. */
  | 'connecting'
  /** Receiving updates. */
  | 'live'
  /** The stream dropped and the browser is retrying, or a frame arrived that
   *  we could not read. Either way what is on screen may be behind. */
  | 'reconnecting'
  /** The server closed us out for good — in practice, access was revoked. */
  | 'ended'

export interface LiveNote {
  status: LiveStatus
  /** Latest content the server sent, or null before the first frame. */
  state: LiveNoteState | null
}

export interface UseLiveNoteOptions {
  vaultId: string
  path: string
  /** True for read-only users. Editors join the Yjs doc instead — see
   *  {@link import('./useCollabDoc.js').useCollabDoc}. */
  enabled: boolean
}

/**
 * Read-only live view over the SSE hub (`server/src/sync/routes.ts`). The first
 * frame is the current note, and every editor keystroke that reaches the relay
 * produces another. Viewers deliberately get no awareness data at all — the
 * audit's presence rule is enforced by them never joining the document.
 *
 * `EventSource` reconnects on its own, so a blip is `reconnecting`, not an
 * error. A revoked viewer is dropped server-side and the retry 404s; the stream
 * closes for good and that is `ended`.
 */
export function useLiveNote({ vaultId, path, enabled }: UseLiveNoteOptions): LiveNote {
  const [status, setStatus] = useState<LiveStatus>('connecting')
  const [state, setState] = useState<LiveNoteState | null>(null)
  const everOpen = useRef(false)

  useEffect(() => {
    if (!enabled) return
    everOpen.current = false
    const source = new EventSource(liveNoteUrl(vaultId, path), { withCredentials: true })

    source.onopen = () => {
      everOpen.current = true
      setStatus('live')
    }
    source.onmessage = (event) => {
      let next: LiveNoteState
      try {
        next = JSON.parse(event.data as string) as LiveNoteState
      } catch {
        // A frame we cannot parse would otherwise throw out of the handler and
        // leave a reader staring at stale content still labelled live. Keep the
        // last good state — it is all we have — but stop calling it current.
        setStatus('reconnecting')
        return
      }
      setState(next)
      setStatus('live')
    }
    source.onerror = () => {
      // CLOSED means EventSource has given up (a 404 on retry, i.e. access
      // gone). Anything else is its own retry loop, still running.
      if (source.readyState === EventSource.CLOSED) setStatus('ended')
      else setStatus(everOpen.current ? 'reconnecting' : 'connecting')
    }

    return () => source.close()
  }, [vaultId, path, enabled])

  return { status, state }
}
