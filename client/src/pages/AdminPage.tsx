import { useState } from 'react'
import { Link } from 'react-router'
import { AccessOversight } from '../components/admin/AccessOversight.js'
import { ApprovalQueue } from '../components/admin/ApprovalQueue.js'
import { InstanceActivity } from '../components/admin/InstanceActivity.js'
import { InstanceOverview } from '../components/admin/InstanceOverview.js'
import { UserRoster } from '../components/admin/UserRoster.js'
import { VaultOversight } from '../components/admin/VaultOversight.js'
import { useSession } from '../hooks/useSession.js'

const SECTIONS = [
  { id: 'overview', label: 'Overview', render: () => <InstanceOverview /> },
  { id: 'approvals', label: 'Approvals', render: () => <ApprovalQueue /> },
  { id: 'people', label: 'People', render: () => <UserRoster /> },
  { id: 'vaults', label: 'Vaults & teams', render: () => <VaultOversight /> },
  { id: 'access', label: 'Access', render: () => <AccessOversight /> },
  { id: 'activity', label: 'Activity', render: () => <InstanceActivity /> },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/**
 * Admin oversight. Every view here is metadata — the spec's content boundary
 * is a hard one, and no endpoint behind this page serves a note's text.
 *
 * Sections render one at a time rather than all down one page: each is a
 * separate query, and an admin opening the approval queue should not fire six
 * instance-wide table reads to get there.
 */
export function AdminPage() {
  const session = useSession()
  const [active, setActive] = useState<SectionId>('approvals')

  // RequireAuth has already established there is a session; this is the role
  // gate. The server enforces it too (403 on every /api/admin route) — this
  // exists so a member sees an explanation instead of six failed requests.
  if (session.data && session.data.role !== 'admin') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
        <h1 className="font-display text-2xl text-foreground">This area is for admins.</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Ask an admin on this instance if you need something from it.
        </p>
        <Link to="/" className="text-sm text-foreground underline">
          ← Back home
        </Link>
      </div>
    )
  }

  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0]

  return (
    <div className="min-h-screen bg-background px-6 py-8">
      <header className="mx-auto mb-6 max-w-4xl">
        <Link to="/" className="mb-1 block text-sm text-muted-foreground underline">
          ← Home
        </Link>
        <h1 className="font-display text-3xl text-foreground">Admin</h1>
      </header>

      <nav aria-label="Admin sections" className="mx-auto mb-6 flex max-w-4xl flex-wrap gap-1">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-current={s.id === active ? 'page' : undefined}
            onClick={() => setActive(s.id)}
            className={
              s.id === active
                ? 'rounded-lg bg-muted px-3 py-1.5 text-sm text-foreground'
                : 'rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground'
            }
          >
            {s.label}
          </button>
        ))}
      </nav>

      <main className="mx-auto max-w-4xl">{section.render()}</main>
    </div>
  )
}
