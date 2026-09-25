import { Pill } from '../ui/pill.js'
import { ExpandableSearch } from './ExpandableSearch.js'
import { useShell } from './shell-context.js'

/**
 * Top header containing telemetry status indicator and the expandable command search.
 */
export function TopBar() {
  const shell = useShell()

  return (
    <header className="col-start-2 row-start-1 flex h-11 items-center justify-between gap-3 bg-transparent px-3 select-none">
      <div className="flex items-center min-w-0">
        {shell.status && (
          <Pill tone={shell.status.tone} dot role="status" className="inline-flex">
            {shell.status.label}
          </Pill>
        )}
      </div>

      <div className="flex items-center justify-end flex-1 min-w-0">
        <ExpandableSearch />
      </div>
    </header>
  )
}
