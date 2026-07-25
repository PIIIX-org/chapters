import { useEffect, useState } from 'react'
import { SearchOverlay } from './SearchOverlay'

// The palette shortcut is Cmd+K on macOS, Ctrl+K elsewhere. Using the
// platform's own modifier (rather than `meta || ctrl`) avoids clobbering the
// editor's Ctrl+K = kill-to-line-end on macOS; excluding Shift avoids the
// editor's Shift+Mod+K = delete-line. Both CodeMirror bindings bubble to
// window, so without these guards a line-delete would also pop search open.
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

export function GlobalSearch() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const modifier = IS_MAC ? e.metaKey : e.ctrlKey
      if (modifier && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return <SearchOverlay open={open} onClose={() => setOpen(false)} />
}
