import { useState } from 'react'
import { AccessOversight } from '../components/admin/AccessOversight.js'
import { ApprovalQueue } from '../components/admin/ApprovalQueue.js'
import { InstanceActivity } from '../components/admin/InstanceActivity.js'
import { InstanceOverview } from '../components/admin/InstanceOverview.js'
import { UserRoster } from '../components/admin/UserRoster.js'
import { VaultOversight } from '../components/admin/VaultOversight.js'
import { Activity, Key, LayoutDashboard, Library, UserCheck, Users } from 'lucide-react'
import { ContextPanel, PanelRailButton, PanelRailNav } from '../components/shell/ShellPanels.js'
import { useShellBreadcrumb } from '../components/shell/shell-context.js'
import { PanelState } from '../components/ui/empty-state.js'
import { Eyebrow } from '../components/ui/eyebrow.js'
import { useSession } from '../hooks/useSession.js'
import { cn } from '../lib/utils.js'
import { isAdminRole } from '../api/admin.js'

const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, render: () => <InstanceOverview /> },
  { id: 'approvals', label: 'Approvals', icon: UserCheck, render: () => <ApprovalQueue /> },
  { id: 'people', label: 'People', icon: Users, render: () => <UserRoster /> },
  { id: 'vaults', label: 'Vaults & teams', icon: Library, render: () => <VaultOversight /> },
  { id: 'access', label: 'Access', icon: Key, render: () => <AccessOversight /> },
  { id: 'activity', label: 'Activity', icon: Activity, render: () => <InstanceActivity /> },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/**
 * Admin oversight. Every view here is metadata — the spec's content boundary
 * is a hard one, and no endpoint behind this page serves a note's text.
 *
 * Sections render one at a time rather than all down one page: each is a
 * separate query, and an admin opening the approval queue should not fire six
 * instance-wide table reads to get there. The section list is the page's
 * context panel.
 */
export function AdminPage() {
  const session = useSession()
  const [active, setActive] = useState<SectionId>('approvals')
  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0]
  useShellBreadcrumb([{ label: 'Admin' }, { label: section.label }])

  // Nothing below renders until the role is known. Checking `session.data &&
  // role !== 'admin'` instead would let every section mount during the one
  // pending tick and fire its instance-wide read — which is the six 403s this
  // gate exists to prevent, just too fast to see.
  if (session.isPending) {
    return <PanelState status="loading" className="h-full" />
  }

  // RequireAuth has already established there is a session; this is the role
  // gate. The server enforces it too (403 on every /api/admin route) — this
  // exists so a member sees an explanation instead of six failed requests.
  if (!isAdminRole(session.data?.role)) {
    return (
      <PanelState
        status="empty"
        title="This area is for admins."
        message="Ask an admin on this instance if you need something from it."
        className="h-full"
      />
    )
  }

  return (
    <>
      <ContextPanel
        label="Admin sections"
        collapsed={
          <PanelRailNav label="Admin sections">
            {SECTIONS.map((s) => (
              <PanelRailButton
                key={s.id}
                icon={s.icon}
                label={s.label}
                active={s.id === active}
                onClick={() => setActive(s.id)}
              />
            ))}
          </PanelRailNav>
        }
      >
        <div className="flex h-9 shrink-0 items-center border-b border-border px-3">
          <Eyebrow as="h2">Admin</Eyebrow>
        </div>
        <nav aria-label="Admin sections" className="flex flex-col gap-0.5 p-2">
          {SECTIONS.map((s) => {
            const Icon = s.icon
            return (
              <button
                key={s.id}
                type="button"
                aria-current={s.id === active ? 'page' : undefined}
                onClick={() => setActive(s.id)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/40',
                  s.id === active
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span>{s.label}</span>
              </button>
            )
          })}
        </nav>
      </ContextPanel>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 pt-5 pb-16">{section.render()}</div>
      </div>
    </>
  )
}
