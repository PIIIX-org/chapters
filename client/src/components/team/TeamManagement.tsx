import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '../ui/input.js'
import { Button } from '../ui/button.js'
import { PanelState } from '../ui/empty-state.js'
import { Eyebrow } from '../ui/eyebrow.js'
import { Panel, PanelBody, PanelFooter, PanelHeader } from '../ui/panel.js'
import { Pill } from '../ui/pill.js'
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

interface ConfirmBlockProps {
  label: string
  consequence: string
  pending: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}

/** Inline consequence → confirm, for the two destructive actions here. */
function ConfirmBlock({ label, consequence, pending, error, onConfirm, onCancel }: ConfirmBlockProps) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2">
      <p className="text-xs whitespace-normal text-muted-foreground">{consequence}</p>
      <div className="flex items-center gap-1">
        <Button type="button" size="xs" variant="destructive" disabled={pending} onClick={onConfirm}>
          {label}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <FormError message={error} />
    </div>
  )
}

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

  const removalTarget =
    isOwner && removingUserId
      ? (members.data ?? []).find((m) => m.userId === removingUserId)
      : undefined

  return (
    <Panel aria-label={team.name}>
      <PanelHeader
        title={team.name}
        titleAs="h3"
        actions={<Pill tone={isOwner ? 'human' : 'neutral'}>{team.role}</Pill>}
      />
      {members.isPending ? (
        <PanelState status="loading" compact message="Loading members…" />
      ) : members.isError ? (
        <PanelState status="error" compact message={members.error.message} />
      ) : (
        <PanelBody dense className="flex flex-col gap-1">
          <ul className="flex flex-col">
            {members.data.map((m) => (
              <li key={m.userId} className="flex h-8 min-w-0 items-center gap-2 px-1 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">{m.email}</span>
                <Pill tone={m.role === 'owner' ? 'human' : 'neutral'}>{m.role}</Pill>
                {isOwner && m.role === 'member' && removingUserId !== m.userId && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    aria-label={`Remove ${m.email} from ${team.name}`}
                    onClick={() => setRemovingUserId(m.userId)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {isOwner && (
            <p className="px-1 text-xs whitespace-normal text-faint">
              The team&rsquo;s owner cannot be removed — delete the team instead.
            </p>
          )}
          {removalTarget && (
            <ConfirmBlock
              label="Remove"
              consequence={`Remove ${removalTarget.email} from ${team.name}? They lose access to every vault shared with this team, immediately.`}
              pending={removeMember.isPending}
              error={removeMember.error?.message ?? null}
              onConfirm={() =>
                removeMember.mutate(removalTarget.userId, {
                  onSuccess: () => setRemovingUserId(null),
                })
              }
              onCancel={() => setRemovingUserId(null)}
            />
          )}
        </PanelBody>
      )}
      {isOwner && (
        <PanelFooter className="flex-col items-stretch gap-2 py-2">
          <form onSubmit={handleAddMember} className="flex items-center gap-1">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-label={`Add member to ${team.name}`}
              placeholder="email@example.com"
              className="h-7 flex-1 text-[13px]"
            />
            <Button type="submit" size="sm" disabled={addBusy || addMember.isPending}>
              Add
            </Button>
          </form>
          <FormError message={addError} />
          {confirmingDelete ? (
            <ConfirmBlock
              label="Delete team"
              consequence={`Delete ${team.name}? Its ${members.data?.length ?? 0} members lose it, and every vault shared with this team loses that share. This cannot be undone.`}
              pending={deleteTeamMutation.isPending}
              error={deleteTeamMutation.error?.message ?? null}
              onConfirm={() => deleteTeamMutation.mutate(team.id)}
              onCancel={() => setConfirmingDelete(false)}
            />
          ) : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label={`Delete ${team.name}`}
              onClick={() => setConfirmingDelete(true)}
              className="self-start"
            >
              Delete team
            </Button>
          )}
        </PanelFooter>
      )}
    </Panel>
  )
}

/**
 * Team create + member management, for team owners. Renders one panel per
 * team the caller belongs to; management controls (add/remove member,
 * delete team) only render on a panel where `role === 'owner'` — the server
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
    <section aria-label="Manage teams" className="flex flex-col gap-3">
      <form onSubmit={handleCreate} className="flex flex-col gap-1.5">
        <Eyebrow as="h3">New team</Eyebrow>
        <div className="flex items-center gap-1">
          <Input
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            aria-label="New team name"
            placeholder="Team name"
            className="h-7 flex-1 text-[13px]"
          />
          <Button type="submit" size="sm" disabled={createTeam.isPending}>
            Create team
          </Button>
        </div>
      </form>
      <FormError message={createError} />

      {teams.isPending ? (
        <PanelState status="loading" compact message="Loading teams…" />
      ) : teams.isError ? (
        <PanelState status="error" compact message={teams.error.message} />
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
