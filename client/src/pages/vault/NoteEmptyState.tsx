import { PanelState } from '../../components/ui/empty-state.js'
import { Kbd } from '../../components/ui/kbd.js'

export function NoteEmptyState() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto">
      <PanelState
        status="empty"
        title="Pick a note from the panel"
        message={
          <>
            Or press <Kbd>⌘K</Kbd> to search every note and file.
          </>
        }
      />
    </div>
  )
}
