import { useState } from 'react'
import { Button } from '../ui/button.js'
import { SecretReveal } from '../ui/SecretReveal.js'
import { ConfirmAction } from '../admin/ConfirmAction.js'
import { FormError } from '../FormError.js'
import { useCreateSyncToken, useRevokeSyncToken, useSyncTokens } from '../../hooks/useRepositories.js'
import type { SyncToken } from '../../api/repositories.js'

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString()
}

/**
 * `repository_sync_tokens` has no name column (gap 6 of the unit 7 plan), so a
 * token is identified by the head of its id — enough to tell two rows apart
 * when revoking, which is the only thing this list is for.
 */
function shortId(id: string): string {
  return id.slice(0, 8)
}

function SyncTokenRow({ token, repositoryId }: { token: SyncToken; repositoryId: string }) {
  const [error, setError] = useState<string | null>(null)
  const revoke = useRevokeSyncToken(repositoryId)

  return (
    <li className="flex items-start justify-between gap-2 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-sm text-foreground">{shortId(token.id)}</div>
        <div className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
          <span>Created {formatTimestamp(token.createdAt)}</span>
          <span>{token.lastUsedAt ? `Last used ${formatTimestamp(token.lastUsedAt)}` : 'Never used'}</span>
        </div>
      </div>
      <ConfirmAction
        label="Revoke"
        ariaLabel={`Revoke sync token ${shortId(token.id)}`}
        destructive
        pending={revoke.isPending}
        error={error}
        consequence={`Any agent pushing with token ${shortId(
          token.id,
        )} stops being able to send files, on its next request. Everything already indexed stays; nothing new arrives from it until you issue another token.`}
        onConfirm={() => {
          setError(null)
          revoke.mutate(token.id, {
            onError: (err) => setError(err.message || 'Could not revoke this token.'),
          })
        }}
      />
    </li>
  )
}

/**
 * Sync tokens for one repository — list, create, revoke. Owner-only: every
 * call behind it is `requireOwner`, and a viewer's would 404, so the caller
 * renders this only for an owner rather than showing a door that isn't theirs.
 *
 * A new token is returned exactly once and goes straight into `SecretReveal`,
 * the same component MCP tokens and the webhook secret use. Nothing here
 * caches it.
 */
export function SyncTokenList({ repositoryId }: { repositoryId: string }) {
  const tokensQuery = useSyncTokens(repositoryId)
  const createToken = useCreateSyncToken(repositoryId)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Revoked tokens are still rows on the server; they grant nothing, so they
  // are not part of "who can push", same as MCP connections.
  const live = (tokensQuery.data ?? []).filter((t) => t.revokedAt === null)

  function handleCreate() {
    setError(null)
    createToken.mutate(undefined, {
      onSuccess: ({ token }) => setRevealed(token),
      onError: (err) => setError(err.message || 'Could not create a sync token.'),
    })
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-display text-base text-foreground">Sync tokens</h3>
      <p className="text-xs text-muted-foreground">
        A sync token lets an agent push this repository&rsquo;s files in over the API. It reaches this repository
        only, and it is the only credential that can write to its index.
      </p>

      {revealed && (
        <SecretReveal
          label="Sync token"
          secret={revealed}
          note="Give it to the agent that pushes this repository now."
          onDismiss={() => setRevealed(null)}
        />
      )}

      {/* isError before .data, always: a list that failed to load must not
          render as "no tokens yet", which reads as an invitation to make a
          second one. */}
      {tokensQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {tokensQuery.error.message || "Could not load this repository's sync tokens. Try again."}
        </p>
      ) : tokensQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading sync tokens…</p>
      ) : live.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sync tokens for this repository yet.</p>
      ) : (
        <ul>
          {live.map((token) => (
            <SyncTokenRow key={token.id} token={token} repositoryId={repositoryId} />
          ))}
        </ul>
      )}

      <Button
        type="button"
        size="sm"
        className="self-start"
        disabled={createToken.isPending}
        onClick={handleCreate}
      >
        {createToken.isPending ? 'Creating…' : 'Create sync token'}
      </Button>
      <FormError message={error} />
    </section>
  )
}
