import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '../ui/input.js'
import { Button } from '../ui/button.js'
import { Label } from '../ui/label.js'
import { Eyebrow } from '../ui/eyebrow.js'
import { FormError } from '../FormError.js'
import { useCreateShare, useLookupUser, useRevokeShare, useShares, useTeams } from '../../hooks/useShares.js'
import type { Share, SharePermission } from '../../api/shares.js'

interface SharingPanelProps {
  vaultId: string
}

// Native <select> — no shadcn select is installed here, and a form control
// this simple doesn't earn one.
const selectClassName =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

function PermissionSelect({
  value,
  onChange,
  label,
}: {
  value: SharePermission
  onChange: (p: SharePermission) => void
  label: string
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as SharePermission)}
      className={selectClassName}
    >
      <option value="read">Read</option>
      <option value="edit">Edit</option>
    </select>
  )
}

function AddByEmailForm({ vaultId }: { vaultId: string }) {
  const [email, setEmail] = useState('')
  const [permission, setPermission] = useState<SharePermission>('read')
  const [error, setError] = useState<string | null>(null)
  const lookupUser = useLookupUser()
  const createShare = useCreateShare(vaultId)
  const pending = lookupUser.isPending || createShare.isPending

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed) return
    setError(null)
    lookupUser.mutate(trimmed, {
      onSuccess: (user) => {
        createShare.mutate(
          { granteeType: 'user', granteeId: user.id, permission },
          {
            onSuccess: () => setEmail(''),
            onError: (err) => setError(err.message || 'Could not share this vault.'),
          },
        )
      },
      onError: (err) => {
        setError(
          err.status === 404
            ? 'No active account with that email. They need an account on this instance before you can share with them.'
            : err.message || 'Could not look up that email.',
        )
      },
    })
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="share-email">Share with a person</Label>
          <Input
            id="share-email"
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
        <PermissionSelect value={permission} onChange={setPermission} label="Permission for this person" />
        <Button type="submit" disabled={pending}>
          Add
        </Button>
      </div>
      <FormError message={error} />
    </form>
  )
}

function AddTeamForm({ vaultId }: { vaultId: string }) {
  const teamsQuery = useTeams()
  const teams = teamsQuery.data ?? []
  const [teamId, setTeamId] = useState('')
  const [permission, setPermission] = useState<SharePermission>('read')
  const [error, setError] = useState<string | null>(null)
  const createShare = useCreateShare(vaultId)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!teamId) return
    setError(null)
    createShare.mutate(
      { granteeType: 'team', granteeId: teamId, permission },
      {
        onSuccess: () => setTeamId(''),
        onError: (err) => setError(err.message || 'Could not share this vault with that team.'),
      },
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="share-team">Share with a team</Label>
          <select
            id="share-team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className={selectClassName}
          >
            <option value="">Choose a team…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <PermissionSelect value={permission} onChange={setPermission} label="Permission for this team" />
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
  vaultId,
}: {
  share: Share
  teamName: string | null
  vaultId: string
}) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revokeShare = useRevokeShare(vaultId)

  const granteeDisplay =
    share.granteeType === 'user' ? (share.email ?? share.granteeId) : (teamName ?? `Team ${share.granteeId}`)

  function handleRevoke() {
    setError(null)
    revokeShare.mutate(share.id, {
      onSuccess: () => setConfirming(false),
      onError: (err) => setError(err.message || 'Could not revoke this share.'),
    })
  }

  return (
    <li className="flex flex-col gap-1 border-b border-border py-2 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          {share.granteeType === 'user' ? (
            <div className="truncate text-sm text-foreground">
              {share.email ?? <span className="font-mono text-xs">{share.granteeId}</span>}
            </div>
          ) : (
            <div className="text-sm text-foreground">
              {teamName ? (
                `Team: ${teamName}`
              ) : (
                <span title="This team's name isn't visible because you aren't currently a member of it.">
                  Team <span className="font-mono text-xs text-muted-foreground">{share.granteeId}</span>
                </span>
              )}
            </div>
          )}
          {share.granteeType === 'team' && (
            <div className="truncate text-xs text-muted-foreground">
              {share.members && share.members.length > 0 ? share.members.map((m) => m.email).join(', ') : 'No current members'}
            </div>
          )}
        </div>
        <span className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">{share.permission}</span>
        {!confirming && (
          <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
      </div>
      {confirming && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            Revoke {share.permission} access for {granteeDisplay}? They lose this vault immediately and any open
            session stops syncing. Notes they already exported stay with them.
          </p>
          <div className="flex items-center gap-1">
            <Button type="button" size="xs" variant="destructive" onClick={handleRevoke} disabled={revokeShare.isPending}>
              Revoke
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
          <FormError message={error} />
        </div>
      )}
    </li>
  )
}

export function SharingPanel({ vaultId }: SharingPanelProps) {
  const sharesQuery = useShares(vaultId)
  const teamsQuery = useTeams()

  function teamNameFor(teamId: string): string | null {
    return teamsQuery.data?.find((t) => t.id === teamId)?.name ?? null
  }

  return (
    <section className="flex flex-col gap-3">
      <Eyebrow as="h3">Sharing</Eyebrow>
      <p className="text-xs text-muted-foreground">
        Access is re-checked on every request — a change here takes effect immediately, including for anyone reading
        right now.
      </p>

      {sharesQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load who has access to this vault. Try again.
        </p>
      ) : sharesQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading who has access…</p>
      ) : sharesQuery.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No one else has access to this vault yet.</p>
      ) : (
        <ul>
          {sharesQuery.data.map((share) => (
            <ShareRow
              key={share.id}
              share={share}
              vaultId={vaultId}
              teamName={share.granteeType === 'team' ? teamNameFor(share.granteeId) : null}
            />
          ))}
        </ul>
      )}

      <AddByEmailForm vaultId={vaultId} />
      <AddTeamForm vaultId={vaultId} />
    </section>
  )
}
