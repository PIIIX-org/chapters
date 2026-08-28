import { useState } from 'react'
import { Button } from '../ui/button.js'
import { SecretReveal } from '../ui/SecretReveal.js'
import { ConfirmAction } from '../admin/ConfirmAction.js'
import { FormError } from '../FormError.js'
import { useCreateWebhookSecret } from '../../hooks/useRepositories.js'
import type { Repository, WebhookSecret } from '../../api/repositories.js'

/**
 * Webhook setup for a git-sourced repository. The secret is generated server
 * side and returned exactly once, so it is shown through `SecretReveal` with
 * the path to paste beside it — the two are useless apart, and this is the
 * only moment either is on screen together.
 *
 * Regenerating is destructive to something invisible (the git host's copy of
 * the secret), so it confirms inline with that consequence spelled out rather
 * than with a bare "Are you sure?".
 */
export function WebhookSetupCard({ repository }: { repository: Pick<Repository, 'id' | 'ingestionMethod' | 'webhookConfigured'> }) {
  const [revealed, setRevealed] = useState<WebhookSecret | null>(null)
  const [error, setError] = useState<string | null>(null)
  const createSecret = useCreateWebhookSecret(repository.id)

  // Not rendered disabled: a folder or agent-push repository has no git host
  // to configure, and the server refuses the call outright.
  if (repository.ingestionMethod !== 'git') return null

  function handleCreate() {
    setError(null)
    createSecret.mutate(undefined, {
      onSuccess: (secret) => setRevealed(secret),
      onError: (err) => setError(err.message || 'Could not generate a webhook secret.'),
    })
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <h3 className="font-display text-base text-foreground">Webhook</h3>

      {revealed ? (
        <div className="flex flex-col gap-2">
          <SecretReveal
            label="Webhook secret"
            secret={revealed.secret}
            note="Paste it into the git host's webhook settings now, together with the path below."
            onDismiss={() => setRevealed(null)}
          />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">Payload path</span>
            <code className="break-all rounded border border-border bg-muted px-2 py-1 font-mono text-sm text-foreground">
              {revealed.webhookPath}
            </code>
            <p className="text-xs text-muted-foreground">
              Add this to the end of this instance&rsquo;s address to get the payload URL the git host posts to.
            </p>
          </div>
        </div>
      ) : repository.webhookConfigured ? (
        <>
          <p className="text-xs text-muted-foreground">
            A webhook secret is set, so pushes are indexed within seconds.
          </p>
          <ConfirmAction
            label="Regenerate secret"
            ariaLabel="Regenerate the webhook secret"
            destructive
            pending={createSecret.isPending}
            error={error}
            consequence="Regenerating replaces the current secret. Every delivery from the git host keeps failing — and pushes stop being indexed until polling catches them — until you paste the new secret into its webhook settings."
            onConfirm={handleCreate}
          />
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            No webhook yet — Chapters polls this remote on a schedule, so a push takes minutes to appear. A
            webhook indexes it in seconds.
          </p>
          <Button
            type="button"
            size="sm"
            aria-label="Set up the webhook"
            disabled={createSecret.isPending}
            onClick={handleCreate}
            className="self-start"
          >
            {createSecret.isPending ? 'Generating…' : 'Set up webhook'}
          </Button>
          <FormError message={error} />
        </>
      )}
    </section>
  )
}
