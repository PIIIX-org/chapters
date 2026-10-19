import { Button } from '../ui/button.js'

interface UnmergedNoticeProps {
  /** The note's text as this browser kept it from an earlier session. */
  text: string
  onDiscard: () => void
}

/**
 * This browser kept text from an earlier session that never reached the
 * relay, and the relay's copy of the note no longer shares any history with it
 * (the note was re-created, or its sync state was lost). Merging the two would
 * put the whole note in twice, so `useCollabDoc` leaves it out of the document
 * and the person decides: the text is right here to copy, and it stays in this
 * browser until they discard it.
 */
export function UnmergedNotice({ text, onDiscard }: UnmergedNoticeProps) {
  return (
    <div role="status" className="border-b border-border bg-muted px-8 py-3 text-sm">
      <p className="font-medium text-foreground">Text typed offline was not merged.</p>
      <p className="mt-1 text-muted-foreground">
        This browser kept a copy of this note that never reached the server, but the
        note was replaced on the server since, and merging the copy would put the note
        in twice. Copy what you need into the note, then discard the copy.
      </p>
      <textarea
        readOnly
        value={text}
        aria-label="Text kept in this browser"
        className="mt-2 h-32 w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground"
      />
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onDiscard}>
        Discard this copy
      </Button>
    </div>
  )
}
