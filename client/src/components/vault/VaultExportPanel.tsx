import { useState } from 'react'
import { Button } from '../ui/button.js'
import { SecretReveal } from '../ui/SecretReveal.js'
import { FormError } from '../FormError.js'
import { createExportLink, exportDownloadUrl, revokeExportLink } from '../../api/exports.js'
import type { ExportLink } from '../../api/exports.js'

interface VaultExportPanelProps {
  vaultId: string
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleString()
}

export function VaultExportPanel({ vaultId }: VaultExportPanelProps) {
  // ponytail: no list endpoint exists, so this panel can only ever track the
  // one link it just created — a second create replaces the first in state
  // (the server-side link keeps working; it's just no longer revocable here).
  const [created, setCreated] = useState<ExportLink | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [confirmingRevoke, setConfirmingRevoke] = useState(false)
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  async function handleCreate() {
    setError(null)
    setCreating(true)
    try {
      const link = await createExportLink(vaultId)
      setCreated(link)
      setRevealed(true)
      setConfirmingRevoke(false)
      setRevokeError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a link for this vault.')
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke() {
    if (!created) return
    setRevokeError(null)
    setRevoking(true)
    try {
      await revokeExportLink(vaultId, created.id)
      setCreated(null)
      setRevealed(false)
      setConfirmingRevoke(false)
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : 'Could not revoke this link.')
    } finally {
      setRevoking(false)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-display text-base text-foreground">Export</h3>

      <div className="flex flex-col gap-1">
        <a
          href={exportDownloadUrl(vaultId)}
          download
          className="self-start text-sm font-medium text-foreground underline"
        >
          Download a zip of this vault
        </a>
        <p className="text-xs text-muted-foreground">
          Notes exactly as stored, plus a manifest. A copy outlives any later change to who can reach this vault.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {revealed && created && (
          <SecretReveal
            label="Shareable export link"
            secret={`${window.location.origin}/api/export-links/${created.token}`}
            note={`Anyone with this link can download the whole vault, without signing in, until ${formatExpiry(created.expiresAt)}. This is the only time the link is shown.`}
            onDismiss={() => setRevealed(false)}
          />
        )}

        {!revealed && (
          <div className="flex flex-col gap-1">
            <Button type="button" onClick={handleCreate} disabled={creating} className="self-start">
              Create a shareable link
            </Button>
            <FormError message={error} />
          </div>
        )}

        {created && (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">
              Only links created in this session can be revoked here — there is no way to list links created earlier.
            </p>
            {!confirmingRevoke ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirmingRevoke(true)}
                className="self-start"
              >
                Revoke link
              </Button>
            ) : (
              <div className="flex flex-col gap-1">
                <p className="text-xs text-muted-foreground">
                  Revoke this link? It stops working immediately for everyone who has it. A download already in
                  flight is not cancelled.
                </p>
                <div className="flex items-center gap-1">
                  <Button type="button" size="sm" variant="destructive" onClick={handleRevoke} disabled={revoking}>
                    Revoke
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingRevoke(false)}>
                    Cancel
                  </Button>
                </div>
                <FormError message={revokeError} />
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
