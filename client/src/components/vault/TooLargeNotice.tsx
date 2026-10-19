interface TooLargeNoticeProps {
  /** The server's cap on a note body, in UTF-8 bytes. */
  limitBytes: number
  /** The note's size in this tab, measured the same way. */
  bodyBytes: number
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * Said in place when the relay refuses a change because the note would pass
 * the server's size cap (#491, `useCollabDoc`'s `too-large` status). The
 * refused text is not lost: it is still in the editor and kept in this
 * browser, and the note syncs again by itself once it fits. What the person
 * needs is that nothing since the refusal is on the server, and how much to
 * cut.
 */
export function TooLargeNotice({ limitBytes, bodyBytes }: TooLargeNoticeProps) {
  const over = bodyBytes - limitBytes
  return (
    <div role="status" className="border-b border-border bg-muted px-8 py-3 text-sm">
      <p className="font-medium text-foreground">This note is too large to save.</p>
      <p className="mt-1 text-muted-foreground">
        The server keeps notes up to {formatBytes(limitBytes)}, and your last change would make this
        one larger, so it was not saved — nor is anything typed since. It is all still here and kept
        in this browser.{' '}
        {over > 0 ? `The note is ${formatBytes(bodyBytes)}: remove about ${formatBytes(over)}` : 'Remove some text'}, or
        move part of it into another note, and it will sync again.
      </p>
    </div>
  )
}
