import { useState } from 'react'
import { Link } from 'react-router'
import { UserConstellation } from '../components/team/UserConstellation.js'
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
  'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

function TeamEmptyState() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
      <h1 className="font-display text-2xl text-foreground">No teams yet</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Teams are how several people reach a set of vaults at once — share a vault with a team instead of one person
        at a time, and everyone on the team gets the same access.
      </p>
      <Link to="/" className="text-sm text-foreground underline">
        ← Back home
      </Link>
    </div>
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

  // Ordered the same way HomePage orders its vaults check: isPending, then
  // isError, before .data is ever read — `.data` on a pending or errored
  // query isn't the empty-state answer, it's undefined.
  if (teams.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading teams…</p>
      </div>
    )
  }
  if (teams.isError) {
    return (
      <div role="alert" className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
        <h1 className="font-display text-2xl text-foreground">We couldn&rsquo;t load your teams.</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{teams.error.message}</p>
      </div>
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
    <div className="min-h-screen bg-background px-6 py-8">
      <header className="mx-auto mb-8 flex max-w-3xl items-end justify-between gap-4">
        <div>
          <Link to="/" className="mb-1 block text-sm text-muted-foreground underline">
            ← Home
          </Link>
          <h1 className="font-display text-3xl text-foreground">Team</h1>
        </div>
        {teams.data.length > 1 && (
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
        )}
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-8">
        {failed ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-2 rounded-lg border border-destructive/40 bg-card px-4 py-6 text-center"
          >
            <p className="text-sm text-destructive">We couldn&rsquo;t load this team&rsquo;s roster.</p>
            <p className="text-xs text-muted-foreground">
              {(members.error ?? stats.error)?.message ?? 'Something went wrong.'}
            </p>
          </div>
        ) : loading ? (
          <p className="text-center text-sm text-muted-foreground">Loading team…</p>
        ) : (
          <>
            <UserConstellation
              people={roster.map((r) => ({ userId: r.userId, email: r.email, mass: r.notesTouched }))}
            />

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <th scope="col" className="py-2 pr-4 font-normal">
                      Member
                    </th>
                    <th scope="col" className="py-2 pr-4 font-normal">
                      Notes touched
                    </th>
                    <th scope="col" className="py-2 pr-4 font-normal">
                      Projects touched
                    </th>
                    <th scope="col" className="py-2 font-normal">
                      Last activity
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {roster.map((r) => (
                    <tr key={r.userId} className="border-b border-border">
                      <td className="py-2 pr-4 text-foreground">{r.email}</td>
                      <td className="py-2 pr-4 text-foreground">{r.notesTouched}</td>
                      <td className="py-2 pr-4 text-foreground">{r.vaultsTouched}</td>
                      <td className="py-2 font-mono text-xs text-muted-foreground">
                        {formatLastActivity(r.lastActivityAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
