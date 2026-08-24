import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '../ui/input.js'
import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { ApiError } from '../../lib/api.js'
import { lookupUserByEmail } from '../../api/teams.js'
import type { Team } from '../../api/teams.js'
import {
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useRemoveTeamMember,
  useTeamMembers,
  useTeams,
} from '../../hooks/useTeams.js'

interface TeamManagementCardProps {
  team: Team
}

function TeamManagementCard({ team }: TeamManagementCardProps) {
  const isOwner = team.role === 'owner'
  const members = useTeamMembers(team.id)
  const addMember = useAddTeamMember(team.id)
  const removeMember = useRemoveTeamMember(team.id)
  const deleteTeamMutation = useDeleteTeam()

  const [email, setEmail] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [removingUserId, setRemovingUserId] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  async function handleAddMember(e: FormEvent) {
    e.preventDefault()
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) return
    setAddError(null)
    setAddBusy(true)
    try {
      // The server only accepts a userId — this is the one way to turn a
      // typed email into that UUID. A 404 here must not fire the POST.
      const found = await lookupUserByEmail(trimmed)
      addMember.mutate(found.id, {
        onSuccess: () => setEmail(''),
        onError: (err) => setAddError(err.message || 'Could not add that member.'),
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setAddError('No active account with that email on this instance.')
      } else {
        setAddError(err instanceof Error ? err.message : 'Something went wrong.')
      }
    } finally {
      setAddBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-lg text-foreground">{team.name}</h3>
        <span className="font-mono text-xs text-muted-foreground">{team.role}</span>
      </div>

      {members.isPending ? (
        <p className="text-sm text-muted-foreground">Loading members…</p>
      ) : members.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {members.error.message}
        </p>
      ) : (
        <ul className="mb-3 flex flex-col gap-1.5">
          {members.data.map((m) => (
            <li key={m.userId} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-foreground">{m.email}</span>
              {isOwner && m.role === 'member' && removingUserId !== m.userId && (
                <button
                  type="button"
                  onClick={() => setRemovingUserId(m.userId)}
                  aria-label={`Remove ${m.email} from ${team.name}`}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Remove
                </button>
              )}
              {isOwner && m.role === 'owner' && (
                <span className="text-right text-xs text-muted-foreground">
                  The team&rsquo;s owner cannot be removed — delete the team instead.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {isOwner &&
        removingUserId &&
        members.data &&
        (() => {
          const target = members.data.find((m) => m.userId === removingUserId)
          if (!target) return null
          return (
            <div className="mb-3 flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-2">
              <p className="text-xs text-muted-foreground">
                Remove {target.email} from {team.name}? They lose access to every vault shared with this team,
                immediately.
              </p>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="destructive"
                  disabled={removeMember.isPending}
                  onClick={() =>
                    removeMember.mutate(target.userId, { onSuccess: () => setRemovingUserId(null) })
                  }
                >
                  Remove
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => setRemovingUserId(null)}>
                  Cancel
                </Button>
              </div>
              <FormError message={removeMember.error?.message ?? null} />
            </div>
          )
        })()}

      {isOwner && (
        <form onSubmit={handleAddMember} className="flex items-center gap-1">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label={`Add member to ${team.name}`}
            placeholder="email@example.com"
            className="h-8 flex-1"
          />
          <Button type="submit" size="sm" disabled={addBusy || addMember.isPending}>
            Add
          </Button>
        </form>
      )}
      <FormError message={addError} />

      {isOwner &&
        (confirmingDelete ? (
          <div className="mt-3 flex flex-col gap-1 rounded-md border border-destructive/40 p-2">
            <p className="text-xs text-muted-foreground">
              Delete {team.name}? Its {members.data?.length ?? 0} members lose it, and every vault shared with this
              team loses that share. This cannot be undone.
            </p>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={deleteTeamMutation.isPending}
                onClick={() => deleteTeamMutation.mutate(team.id)}
              >
                Delete team
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </div>
            <FormError message={deleteTeamMutation.error?.message ?? null} />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            aria-label={`Delete ${team.name}`}
            className="mt-3 text-xs text-muted-foreground hover:text-foreground"
          >
            Delete team
          </button>
        ))}
    </div>
  )
}

/**
 * Team create + member management, for team owners. Renders one card per
 * team the caller belongs to; management controls (add/remove member,
 * delete team) only render on a card where `role === 'owner'` — the server
 * enforces that with a 403, so this UI must not offer what will fail.
 */
export function TeamManagement() {
  const teams = useTeams()
  const createTeam = useCreateTeam()
  const [newTeamName, setNewTeamName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  function handleCreate(e: FormEvent) {
    e.preventDefault()
    const trimmed = newTeamName.trim()
    if (!trimmed) return
    setCreateError(null)
    createTeam.mutate(trimmed, {
      onSuccess: () => setNewTeamName(''),
      onError: (err) => setCreateError(err.message || 'Could not create the team.'),
    })
  }

  return (
    <section aria-labelledby="team-management-heading" className="flex flex-col gap-4">
      <h2 id="team-management-heading" className="font-display text-xl text-foreground">
        Manage teams
      </h2>

      <form onSubmit={handleCreate} className="flex items-center gap-1">
        <Input
          value={newTeamName}
          onChange={(e) => setNewTeamName(e.target.value)}
          aria-label="New team name"
          placeholder="Team name"
          className="h-8 flex-1"
        />
        <Button type="submit" size="sm" disabled={createTeam.isPending}>
          Create team
        </Button>
      </form>
      <FormError message={createError} />

      {teams.isPending ? (
        <p className="text-sm text-muted-foreground">Loading teams…</p>
      ) : teams.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {teams.error.message}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {teams.data.map((team) => (
            <TeamManagementCard key={team.id} team={team} />
          ))}
        </div>
      )}
    </section>
  )
}
