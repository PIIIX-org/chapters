import { useState } from 'react'
import { Button } from './button.js'

interface SecretRevealProps {
  label: string
  secret: string
  note: string
  onDismiss: () => void
}

/**
 * One-time secret reveal: MCP tokens today, MFA backup codes and webhook
 * secrets in later units. The caller passes the secret in as a prop and
 * unmounts this component on dismiss — nothing here persists it beyond that.
 */
export function SecretReveal({ label, secret, note, onDismiss }: SecretRevealProps) {
  const [copied, setCopied] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  async function handleCopy() {
    // ponytail: graceful no-op when Clipboard API is unavailable (insecure
    // context, older browser) rather than throwing.
    if (!navigator.clipboard?.writeText) return
    await navigator.clipboard.writeText(secret)
    setCopied(true)
  }

  function handleDone() {
    // Self-clear rather than trust the caller to unmount us — the secret
    // must be gone from this tree the instant Done is clicked.
    setDismissed(true)
    onDismiss()
  }

  if (dismissed) return null

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted p-3">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        {/* whitespace-pre-wrap, not nowrap: MFA backup codes arrive as one
            newline-separated string, and nowrap collapsed all of them onto a
            single horizontally-scrolling line — unreadable in exactly the
            situation they exist for, someone copying them down by hand after
            losing their phone. A long MCP token now wraps instead of
            scrolling, which is no worse to read. */}
        <code className="flex-1 whitespace-pre-wrap break-all rounded border border-border bg-card px-2 py-1 font-mono text-sm text-foreground">
          {secret}
        </code>
        <Button type="button" size="xs" variant="outline" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        This is the only time this value is shown — it is stored hashed and cannot be retrieved again.
      </p>
      <p className="text-xs text-muted-foreground">{note}</p>
      <Button type="button" size="sm" onClick={handleDone} className="self-start">
        Done
      </Button>
    </div>
  )
}
