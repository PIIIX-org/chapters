import { Link, useLocation } from 'react-router'
import { AuthFrame } from '../../components/auth/AuthFrame.js'

export function PendingApprovalPage() {
  const location = useLocation()
  const email = (location.state as { email?: string } | null)?.email ?? ''

  return (
    <AuthFrame
      eyebrow="welcome"
      title="Welcome to Chapters"
      step="Admin approval"
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-[var(--radius-md,4px)] border border-primary/20 bg-primary/5 p-4">
          <h3 className="font-semibold text-foreground">Email confirmed.</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Welcome to Chapters{email ? `, ${email}` : ''}! Your account has been created and your email is verified.
          </p>
        </div>

        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p className="text-foreground font-medium">Waiting for approval</p>
          <p>
            An administrator on this instance has to approve your account before you can sign in.
            We&rsquo;ll email you the moment they do.
          </p>
          <p className="rounded-[var(--radius-sm,2px)] bg-muted/60 p-3 text-xs text-foreground/90 border border-border">
            Wait for approval or contact your manager to speed up the process.
          </p>
        </div>

        <div className="mt-2 text-center text-xs text-muted-foreground">
          <Link to="/login" className="hover:underline text-foreground">
            Already approved? Sign in
          </Link>
        </div>
      </div>
    </AuthFrame>
  )
}
