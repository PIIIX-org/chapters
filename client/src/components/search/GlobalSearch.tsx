import { useEffect, useState } from 'react'
import { SearchOverlay } from './SearchOverlay'
import { useOptionalShell } from '../shell/shell-context.js'
import { IS_MAC } from '../../lib/platform.js'

// The palette shortcut is Cmd+K on macOS, Ctrl+K elsewhere. Using the
// platform's own modifier (rather than `meta || ctrl`) avoids clobbering the
// editor's Ctrl+K = kill-to-line-end on macOS; excluding Shift avoids the
// editor's Shift+Mod+K = delete-line. Both CodeMirror bindings bubble to
// window, so without these guards a line-delete would also pop search open.

/**
 * Inside the shell the open state lives in ShellProvider so the top bar's
 * command trigger can open the same palette; outside one (a page mounted on
 * its own) it falls back to local state.
 */
export function GlobalSearch() {
  const shell = useOptionalShell()
  const [localOpen, setLocalOpen] = useState(false)
  const open = shell ? shell.paletteOpen : localOpen
  const openPalette = shell?.openPalette
  const closePalette = shell?.closePalette

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const modifier = IS_MAC ? e.metaKey : e.ctrlKey
      if (modifier && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (openPalette) openPalette()
        else setLocalOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openPalette])

  return <SearchOverlay open={open} onClose={closePalette ?? (() => setLocalOpen(false))} />
}
