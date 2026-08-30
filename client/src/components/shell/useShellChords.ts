import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useShell } from './shell-context.js'
import { useSession } from '../../hooks/useSession.js'
import { isEditableTarget } from '../../lib/platform.js'

/** `g` then one of these, within the chord window. */
export const CHORDS: Record<
  string,
  { to: string; label: string; admin?: boolean }
> = {
  g: { to: '/', label: 'Graph' },
  v: { to: '/vaults', label: 'Vaults' },
  r: { to: '/repos', label: 'Repositories' },
  t: { to: '/team', label: 'Team' },
  a: { to: '/admin', label: 'Admin', admin: true },
  s: { to: '/settings', label: 'Settings' },
}

export const CHORD_WINDOW_MS = 800

/**
 * Shell keyboard: `g` chords jump between areas, `[` and `]` toggle the side
 * tracks. Nothing fires while typing — inputs and the editor own their keys.
 */
export function useShellChords(): void {
  const shell = useShell()
  const navigate = useNavigate()
  const session = useSession()
  const isAdmin = session.data?.role === 'admin'
  const { togglePanel } = shell

  useEffect(() => {
    let pendingSince: number | null = null

    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (isEditableTarget(e.target)) return

      if (e.key === '[') {
        e.preventDefault()
        togglePanel('context')
        return
      }
      if (e.key === ']') {
        e.preventDefault()
        togglePanel('inspector')
        return
      }

      const now = Date.now()
      if (pendingSince !== null && now - pendingSince <= CHORD_WINDOW_MS) {
        pendingSince = null
        const chord = CHORDS[e.key.toLowerCase()]
        if (chord && (!chord.admin || isAdmin)) {
          e.preventDefault()
          navigate(chord.to)
        }
        return
      }
      if (e.key === 'g') pendingSince = now
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePanel, navigate, isAdmin])
}
