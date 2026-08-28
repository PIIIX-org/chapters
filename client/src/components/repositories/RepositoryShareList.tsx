import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '../ui/input.js'
import { Button } from '../ui/button.js'
import { Label } from '../ui/label.js'
import { ConfirmAction } from '../admin/ConfirmAction.js'
import { FormError } from '../FormError.js'
import { useLookupUser, useTeams } from '../../hooks/useShares.js'
import {
  useCreateRepositoryShare,
  useRepositoryShares,
  useRevokeRepositoryShare,
} from '../../hooks/useRepositories.js'
import type { RepositoryShare } from '../../api/repositories.js'

// Native <select>, same as the vault sharing panel — no shadcn select is
// installed and one field does not earn one.
const selectClassName =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

function AddPersonForm({ repositoryId }: { repositoryId: string }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const lookupUser = useLookupUser()
  const createShare = useCreateRepositoryShare(repositoryId)
  const pending = lookupUser.isPending || createShare.isPending

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed) return
    setError(null)
    // Two steps because the share endpoint takes a uuid and people know
    // emails — the same route the vault panel takes.
    lookupUser.mutate(trimmed, {
      onSuccess: (user) => {
        createShare.mutate(
          { granteeType: 'user', granteeId: user.id },
          {
            onSuccess: () => setEmail(''),
            onError: (err) => setError(err.message || 'Could not share this repository.'),
          },
        )
      },
      onError: (err) =>
        setError(
          err.status === 404
            ? 'No active account with that email. They need an account on this instance before you can share with them.'
            : err.message || 'Could not look up that email.',
        ),
    })
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="repository-share-email">Share with a person</Label>
          <Input
            id="repository-share-email"
            type="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setError(null)
            }}
            placeholder="ada@example.com"
          />
        </div>
        <Button type="submit" disabled={pending}>
          Add
        </Button>
      </div>
      <FormError message={error} />
    </form>
  )
}

function AddTeamForm({ repositoryId }: { repositoryId: string }) {
  const teamsQuery = useTeams()
  const [teamId, setTeamId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const createShare = useCreateRepositoryShare(repositoryId)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!teamId) return
    setError(null)
    createShare.mutate(
      { granteeType: 'team', granteeId: teamId },
      {
        onSuccess: () => setTeamId(''),
        onError: (err) => setError(err.message || 'Could not share this repository with that team.'),
      },
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="repository-share-team">Share with a team</Label>
          <select
            id="repository-share-team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className={selectClassName}
          >
            <option value="">Choose a team…</option>
            {(teamsQuery.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={createShare.isPending || !teamId}>
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        You can only share with teams you belong to — ask the team&rsquo;s owner to add you, or share with people
        individually.
      </p>
      <FormError message={error} />
    </form>
  )
}

function ShareRow({
  share,
  teamName,
  repositoryId,
}: {
  share: RepositoryShare
  teamName: string | null
  repositoryId: string
}) {
  const [error, setError] = useState<string | null>(null)
  const revoke = useRevokeRepositoryShare(repositoryId)

  // `GET /repositories/:id/shares` expands a team's membership but returns a
  // bare uuid for a person (gap 5 of the unit 7 plan), so a person can only be
  // shown by id until the route carries the email the vault route already does.
  const granteeDisplay =
    share.granteeType === 'user' ? share.granteeId : (teamName ?? `Team ${share.granteeId}`)

  return (
    <li className="flex items-start justify-between gap-2 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        {share.granteeType === 'user' ? (
          <div className="truncate font-mono text-xs text-foreground">{share.granteeId}</div>
        ) : (
          <>
            <div className="truncate text-sm text-foreground">
              {teamName ? (
                `Team: ${teamName}`
              ) : (
                <span title="This team's name isn't visible because you aren't currently a member of it.">
                  Team <span className="font-mono text-xs text-muted-foreground">{share.granteeId}</span>
                </span>
              )}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {share.members && share.members.length > 0
                ? share.members.map((m) => m.email).join(', ')
                : 'No current members'}
            </div>
          </>
        )}
      </div>
      {/* No permission column: a repository grant is binary, because nothing
          in a repository is editable. */}
      <ConfirmAction
        label="Revoke"
        ariaLabel={`Revoke access for ${granteeDisplay}`}
        destructive
        pending={revoke.isPending}
        error={error}
        consequence={`${granteeDisplay} loses this repository immediately, including anyone reading a file from it right now. Their own copies of the code are untouched.`}
        onConfirm={() => {
          setError(null)
          revoke.mutate(share.id, {
            onError: (err) => setError(err.message || 'Could not revoke this share.'),
          })
        }}
      />
    </li>
  )
}

/**
 * Who can read this repository. Deliberately not the vault `SharingPanel`:
 * that one carries a read/edit selector, and a repository grant has no levels
 * because Chapters never writes code back — everyone reached here is a viewer
 * (`2026-07-18-repository-ingestion-design.md`).
 *
 * Owner-only, like every other call on this route.
 */
export function RepositoryShareList({ repositoryId }: { repositoryId: string }) {
  const sharesQuery = useRepositoryShares(repositoryId)
  const teamsQuery = useTeams()

  function teamNameFor(teamId: string): string | null {
    return teamsQuery.data?.find((t) => t.id === teamId)?.name ?? null
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-display text-base text-foreground">Sharing</h3>
      <p className="text-xs text-muted-foreground">
        Everyone here can read this repository&rsquo;s files — there is no edit level, because Chapters never
        writes code back. Access is re-checked on every request, so a change here takes effect immediately.
      </p>

      {/* isError before .data: a roster that failed to load must never read as
          "nobody else has access". */}
      {sharesQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {sharesQuery.error.message || 'Could not load who has access to this repository. Try again.'}
        </p>
      ) : sharesQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading who has access…</p>
      ) : sharesQuery.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No one else has access to this repository yet.</p>
      ) : (
        <ul>
          {sharesQuery.data.map((share) => (
            <ShareRow
              key={share.id}
              share={share}
              repositoryId={repositoryId}
              teamName={share.granteeType === 'team' ? teamNameFor(share.granteeId) : null}
            />
          ))}
        </ul>
      )}

      <AddPersonForm repositoryId={repositoryId} />
      <AddTeamForm repositoryId={repositoryId} />
    </section>
  )
}
