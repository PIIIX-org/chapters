import { formatBytes } from '../../lib/noteSize.js'

interface TooLargeNoticeProps {
  /** The server's cap on a note body, and on the rest of the note (#780), in UTF-8 bytes. */
  limitBytes: number
  /** The note's body in this tab, measured the same way. */
  bodyBytes: number
  /** Everything else in the note in this tab (its properties), measured the same way. */
  otherBytes?: number
}

/**
 * Said in place when the relay refuses a change because the note would pass
 * the server's size cap (#491, `useCollabDoc`'s `too-large` status): its
 * body, or its properties and anything else in it, each up to the cap
 * (#780). The refused text is not lost: it is still in the editor and kept
 * in this browser, and the note syncs again by itself once it fits. What the
 * person needs is that nothing since the refusal is on the server, which
 * part is too large, and how much to cut.
 */
export function TooLargeNotice({ limitBytes, bodyBytes, otherBytes = 0 }: TooLargeNoticeProps) {
  const propertiesOnly = otherBytes > limitBytes && bodyBytes <= limitBytes
  // Each part over the cap, and how much to cut from it.
  const cuts: string[] = []
  if (bodyBytes > limitBytes) cuts.push(`text is ${formatBytes(bodyBytes)}: remove about ${formatBytes(bodyBytes - limitBytes)}`)
  if (otherBytes > limitBytes) {
    cuts.push(`properties are ${formatBytes(otherBytes)}: remove about ${formatBytes(otherBytes - limitBytes)} of them (a very long value, or many of them)`)
  }
  return (
    <div role="status" className="border-b border-border bg-muted px-8 py-3 text-sm">
      <p className="font-medium text-foreground">{propertiesOnly ? "This note's properties are too large to save." : 'This note is too large to save.'}</p>
      <p className="mt-1 text-muted-foreground">
        The server keeps notes up to {formatBytes(limitBytes)} of text and as much again of properties,
        and your last change would make this one larger, so it was not saved — nor is anything typed
        since. It is all still here and kept in this browser.{' '}
        {cuts.length > 0 ? `The ${cuts.join('; the ')}` : 'Remove some text'}, or move part of it into another
        note, and it will sync again. If what you cut is very large, undo history for this note is
        cleared when it does.
      </p>
    </div>
  )
}
