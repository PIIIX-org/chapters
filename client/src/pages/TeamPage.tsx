import { useState } from 'react'
import { TeamManagement } from '../components/team/TeamManagement.js'
import { UserConstellation } from '../components/team/UserConstellation.js'
import { VaultReachExpansion } from '../components/team/VaultReachExpansion.js'
import { Inspector } from '../components/shell/ShellPanels.js'
import { useShellBreadcrumb } from '../components/shell/shell-context.js'
import { PanelState } from '../components/ui/empty-state.js'
import { Eyebrow } from '../components/ui/eyebrow.js'
import { Panel, PanelBody, PanelHeader } from '../components/ui/panel.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js'
import { useTeamMembers, useTeams, useTeamStats } from '../hooks/useTeams.js'

const lastActiveFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

function formatLastActivity(iso: string | null): string {
  if (!iso) return 'No activity yet'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return 'No activity yet'
  return lastActiveFormatter.format(parsed)
}

const selectClassName =
  'h-7 rounded-md border border-input bg-card px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40'

function ManagementPanel() {
  return (
    <Inspector label="Team management" className="gap-4 p-3">
      <div className="flex h-9 shrink-0 items-center border-b border-border">
        <Eyebrow as="h2">Manage</Eyebrow>
      </div>
      <TeamManagement />
      <VaultReachExpansion />
    </Inspector>
  )
}

function TeamEmptyState() {
  return (
    <>
      <PanelState
        status="empty"
        title="No teams yet"
        message="Teams are how several people reach a set of vaults at once — share a vault with a team instead of one person at a time, and everyone on the team gets the same access. Create one from the panel on the right."
        className="h-full"
      />
      <ManagementPanel />
    </>
  )
}

export function TeamPage() {
  const teams = useTeams()
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)
  // '' while the team list is still loading (or there is none) — the member
  // and stats queries below are disabled for an empty id, so this never
  // fires a request for a team that doesn't exist yet.
  const teamId = selectedTeamId ?? teams.data?.[0]?.id ?? ''
  const members = useTeamMembers(teamId)
  const stats = useTeamStats(teamId)
  useShellBreadcrumb([{ label: 'Team' }])

  // Ordered the same way HomePage orders its vaults check: isPending, then
  // isError, before .data is ever read — `.data` on a pending or errored
  // query isn't the empty-state answer, it's undefined.
  if (teams.isPending) {
    return (
      <PanelState
        status="loading"
        message="Loading teams…"
        className="h-full"
      />
    )
  }
  if (teams.isError) {
    return (
      <PanelState
        status="error"
        title="We couldn’t load your teams."
        message={teams.error.message}
        className="h-full"
      />
    )
  }
  if (teams.data.length === 0) return <TeamEmptyState />

  // Aggregate stats, keyed for the merge below — members is the roster's
  // source of truth (who is on the team, including someone with zero
  // activity), stats overlays the numbers onto it. Never drop a member who
  // has no matching stats row into silence: that's how idle members vanish.
  const statsById = new Map((stats.data ?? []).map((row) => [row.userId, row]))
  const roster = (members.data ?? []).map((member) => {
    const agg = statsById.get(member.userId)
    return {
      userId: member.userId,
      email: member.email,
      notesTouched: agg?.notesTouched ?? 0,
      vaultsTouched: agg?.vaultsTouched ?? 0,
      lastActivityAt: agg?.lastActivityAt ?? null,
    }
  })

  const failed = members.isError || stats.isError
  const loading = !failed && (members.isPending || stats.isPending)

  return (
    <>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-5">
          <Panel aria-label="Roster">
            <PanelHeader
              title="Roster"
              actions={
                teams.data.length > 1 ? (
                  <select
                    aria-label="Team"
                    value={teamId}
                    onChange={(e) => setSelectedTeamId(e.target.value)}
                    className={selectClassName}
                  >
                    {teams.data.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-sm text-foreground">
                    {teams.data[0]?.name}
                  </span>
                )
              }
            />
            {failed ? (
              <PanelState
                status="error"
                title="We couldn’t load this team’s roster."
                message={
                  (members.error ?? stats.error)?.message ??
                  'Something went wrong.'
                }
              />
            ) : loading ? (
              <PanelState status="loading" message="Loading team…" />
            ) : (
              <>
                <PanelBody className="border-b border-border">
                  <UserConstellation
                    people={roster.map((r) => ({
                      userId: r.userId,
                      email: r.email,
                      mass: r.notesTouched,
                    }))}
                  />
                </PanelBody>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Member</TableHead>
                      <TableHead scope="col">Notes touched</TableHead>
                      <TableHead scope="col">Projects touched</TableHead>
                      <TableHead scope="col">Last activity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {roster.map((r) => (
                      <TableRow key={r.userId}>
                        <TableCell className="text-foreground">
                          {r.email}
                        </TableCell>
                        <TableCell className="font-mono tabular-nums text-foreground">
                          {r.notesTouched}
                        </TableCell>
                        <TableCell className="font-mono tabular-nums text-foreground">
                          {r.vaultsTouched}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {formatLastActivity(r.lastActivityAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </Panel>
        </div>
      </div>
      <ManagementPanel />
    </>
  )
}
