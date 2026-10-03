import { Pill } from '../ui/pill.js'
import { ExpandableSearch } from './ExpandableSearch.js'
import { UniversalNewButton } from './UniversalNewButton.js'
import { useShell } from './shell-context.js'

/**
 * Top header containing telemetry status indicator, universal new action, and expandable command search.
 */
export function TopBar() {
  const shell = useShell()

  return (
    <header className="flex items-center justify-end gap-2.5 pointer-events-none select-none">
      {shell.status && (
        <div className="pointer-events-auto rounded-full shadow-floating">
          <Pill tone={shell.status.tone} dot role="status" className="inline-flex">
            {shell.status.label}
          </Pill>
        </div>
      )}

      <UniversalNewButton />

      <div className="pointer-events-auto">
        <ExpandableSearch />
      </div>
    </header>
  )
}
