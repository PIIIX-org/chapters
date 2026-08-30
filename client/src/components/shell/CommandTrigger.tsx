import { Search } from 'lucide-react'
import { Kbd } from '../ui/kbd.js'
import { useShell } from './shell-context.js'
import { MOD_KEY_LABEL } from '../../lib/platform.js'

/** Looks like the search field; is the command line. Opens ⌘K. */
export function CommandTrigger() {
  const shell = useShell()
  return (
    <button
      type="button"
      onClick={shell.openPalette}
      aria-label="Open the command palette"
      aria-keyshortcuts="Meta+K Control+K"
      className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-background px-2.5 text-left text-[13px] text-muted-foreground transition-colors duration-100 hover:border-input hover:text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <Search className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="flex-1 truncate">
        Search notes, code, or jump anywhere…
      </span>
      <Kbd aria-hidden="true">{MOD_KEY_LABEL} K</Kbd>
    </button>
  )
}
