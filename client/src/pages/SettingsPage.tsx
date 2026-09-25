import { useState } from 'react'
import { Bell, Bot, Database, Palette, Shield, User } from 'lucide-react'
import { AccountExport } from '../components/settings/AccountExport.js'
import { VaultImport } from '../components/settings/VaultImport.js'
import { AccountSection } from '../components/settings/AccountSection.js'
import { AppearanceSection } from '../components/settings/AppearanceSection.js'
import { MfaSection } from '../components/settings/MfaSection.js'
import { NotificationPreferences } from '../components/settings/NotificationPreferences.js'
import { McpPanel } from '../components/vault/VaultMcpPanel.js'
import { ContextPanel, PanelRailButton, PanelRailNav } from '../components/shell/ShellPanels.js'
import { useShellBreadcrumb } from '../components/shell/shell-context.js'
import { Eyebrow } from '../components/ui/eyebrow.js'
import { useSession } from '../hooks/useSession.js'
import { cn } from '../lib/utils.js'

const SECTIONS = [
  { id: 'account', label: 'Account', icon: User, render: () => <AccountSection /> },
  { id: 'security', label: 'Security', icon: Shield, render: () => <MfaSection /> },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: Bell,
    render: () => <NotificationPreferences />,
  },
  // The same component the vault settings modal uses, in account scope — the
  // spec asks for the component to be reused, not reimplemented.
  { id: 'mcp', label: 'MCP', icon: Bot, render: () => <McpPanel scope="account" /> },
  {
    id: 'data',
    label: 'Data',
    icon: Database,
    render: () => (
      <>
        <AccountExport />
        {/* Directly beneath the export it is the counterpart to. */}
        <VaultImport />
      </>
    ),
  },
  { id: 'appearance', label: 'Appearance', icon: Palette, render: () => <AppearanceSection /> },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/**
 * Settings, sectioned like Admin: the section list is the page's context
 * panel, one section renders at a time, so opening Appearance does not fire
 * the MCP and preferences reads it has nothing to do with.
 */
export function SettingsPage() {
  const session = useSession()
  const [active, setActive] = useState<SectionId>('account')

  // MFA spec, "Enforcement": RequireAuth routes an unenrolled user here when
  // the instance mandates it, so this page has to say why they landed on a
  // page they did not ask for. Under the mandate the server 403s every route
  // this page's other sections call, so only Security renders — showing the
  // rest would fill the screen with panels whose contents are the words "MFA
  // setup required" and bury the one control that ends the state.
  const mustEnrol =
    Boolean(session.data?.mfaRequired) && !session.data?.mfaEnabledAt

  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0]
  useShellBreadcrumb([
    { label: 'Settings' },
    { label: mustEnrol ? 'Security' : section.label },
  ])

  if (mustEnrol) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 pt-5 pb-16">
          {/* Says only what the section below does not: why the rest of the
              page is missing. MfaSection already states the requirement
              itself, and saying it twice on one short screen reads as a
              stutter. */}
          <p
            role="alert"
            className="rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-foreground"
          >
            Your other settings are hidden until two-factor authentication is
            on.
          </p>
          <MfaSection />
        </div>
      </div>
    )
  }

  return (
    <>
      <ContextPanel
        label="Settings sections"
        collapsed={
          <PanelRailNav label="Settings sections">
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
          <Eyebrow as="h2">Settings</Eyebrow>
        </div>
        <nav
          aria-label="Settings sections"
          className="flex flex-col gap-0.5 p-2"
        >
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
        <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 pt-5 pb-16">
          {section.render()}
        </div>
      </div>
    </>
  )
}
