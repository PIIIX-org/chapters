import { Link } from 'react-router'
import { AccountExport } from '../components/settings/AccountExport.js'
import { AccountSection } from '../components/settings/AccountSection.js'
import { MfaSection } from '../components/settings/MfaSection.js'
import { NotificationPreferences } from '../components/settings/NotificationPreferences.js'
import { McpPanel } from '../components/vault/VaultMcpPanel.js'
import { useSession } from '../hooks/useSession.js'

/**
 * One scrolling page, not a section switcher like Admin: these are five short
 * panels a person reads top to bottom once, and hiding four of them behind
 * tabs would cost a click to find the one they came for.
 */
export function SettingsPage() {
  const session = useSession()

  // MFA spec, "Enforcement": RequireAuth routes an unenrolled user here when
  // the instance mandates it, so this page has to say why they landed on a
  // page they did not ask for.
  const mustEnrol = Boolean(session.data?.mfaRequired) && !session.data?.mfaEnabledAt

  return (
    <div className="min-h-screen bg-background px-6 py-8">
      <header className="mx-auto mb-6 max-w-2xl">
        <Link to="/" className="mb-1 block text-sm text-muted-foreground underline">
          ← Home
        </Link>
        <h1 className="font-display text-3xl text-foreground">Settings</h1>
      </header>

      <main className="mx-auto flex max-w-2xl flex-col gap-10">
        {mustEnrol && (
          <p role="alert" className="rounded-lg border border-border bg-card p-4 text-sm text-foreground">
            An admin requires two-factor authentication on this instance. Set it up below to reach the rest of
            Chapters.
          </p>
        )}

        <MfaSection />
        <AccountSection />
        <NotificationPreferences />
        {/* The same component the vault settings modal uses, in account scope —
            the spec asks for the component to be reused, not reimplemented. */}
        <McpPanel scope="account" />
        <AccountExport />
      </main>
    </div>
  )
}
