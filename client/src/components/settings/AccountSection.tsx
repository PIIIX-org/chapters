import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Panel, PanelBody, PanelHeader } from '../ui/panel.js'
import { FormError } from '../FormError.js'
import { ConfirmAction } from '../admin/ConfirmAction.js'
import { useChangeEmail, useChangePassword } from '../../hooks/useAccount.js'
import { useSession } from '../../hooks/useSession.js'

const MISMATCH = 'The new password and the confirmation are not the same. Type them again.'
/** The server's own floor (account-routes.ts credentialsSchema). */
const MIN_PASSWORD_LENGTH = 8

// Deliberately loose: the server's ajv `format: email` is the real gate. This
// only exists to catch "sam" before the confirm step, not to relitigate RFC 5322.
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const TAKEN = 'That address already belongs to another account. Try a different one.'

/**
 * Credentials. Both halves change something the login screen checks, so both
 * say what happens afterwards before it happens: a password change ends every
 * other session, and an email change locks you out until you enter the code
 * sent to the new address.
 */
export function AccountSection() {
  const session = useSession()
  const changeEmail = useChangeEmail()
  const changePassword = useChangePassword()

  const [newEmail, setNewEmail] = useState('')
  const [emailPassword, setEmailPassword] = useState('')
  const [emailFieldError, setEmailFieldError] = useState<string | null>(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  // One slot for both local guards below, so each can carry its own reason.
  const [passwordFieldError, setPasswordFieldError] = useState<string | null>(null)

  if (session.isPending) return <p className="text-sm text-muted-foreground">Loading your account…</p>
  if (session.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {session.error.message}
      </p>
    )
  }

  function submitPassword(e: FormEvent) {
    e.preventDefault()
    // Guarded here rather than at the server: a mismatch is the user's own
    // typo, and sending it would burn a wrong-password attempt on it.
    // The server's floor, checked here too. Without it a short password comes
    // back as Fastify's schema rejection, whose `error` field is the literal
    // string "Bad Request" — which is what ApiError surfaces, so the person is
    // told "Bad Request" and never learns the rule.
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordFieldError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordFieldError(MISMATCH)
      return
    }
    setPasswordFieldError(null)
    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setCurrentPassword('')
          setNewPassword('')
          setConfirmPassword('')
        },
      },
    )
  }

  function confirmEmail() {
    if (!newEmail || !emailPassword) {
      setEmailFieldError('Enter the new address and your current password.')
      return
    }
    // Checked before the confirm, not after: the server enforces `format:
    // email` and its rejection also arrives as the bare string "Bad Request",
    // which would land only once the person had already read and accepted the
    // lockout consequence. type="email" does nothing here — ConfirmAction's
    // button is type="button", so there is no native form validation to fire.
    if (!LOOKS_LIKE_EMAIL.test(newEmail)) {
      setEmailFieldError('That does not look like an email address.')
      return
    }
    setEmailFieldError(null)
    changeEmail.mutate(
      { email: newEmail, password: emailPassword },
      { onSuccess: () => setEmailPassword('') },
    )
  }

  const emailError =
    emailFieldError ??
    (changeEmail.error ? (changeEmail.error.status === 409 ? TAKEN : changeEmail.error.message) : null)

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader title="Password" />
        <PanelBody>
          <form onSubmit={submitPassword} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="account-current-password">Current password</Label>
              <Input
                id="account-current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="account-new-password">New password</Label>
              <Input
                id="account-new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="account-confirm-password">Confirm new password</Label>
              <Input
                id="account-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Changing your password signs out every other device you are signed in on. This one stays
              signed in.
            </p>
            <FormError message={passwordFieldError ?? changePassword.error?.message ?? null} />
            {changePassword.isSuccess && !passwordFieldError && (
              <p role="status" className="text-sm text-foreground">
                Password changed. Every other device signed in as you has been signed out — they will
                each need the new password.
              </p>
            )}
            <Button type="submit" className="w-fit" disabled={changePassword.isPending}>
              Change password
            </Button>
          </form>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Email address" />
        <PanelBody className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            You sign in as <span className="font-mono text-foreground">{session.data.email}</span>.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-new-email">New email address</Label>
            <Input
              id="account-new-email"
              type="email"
              autoComplete="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-email-password">Your password</Label>
            <Input
              id="account-email-password"
              type="password"
              autoComplete="current-password"
              value={emailPassword}
              onChange={(e) => setEmailPassword(e.target.value)}
            />
          </div>
          {changeEmail.isSuccess ? (
            <div role="status" className="flex flex-col gap-1 text-sm text-foreground">
              <p>
                A code is on its way to {newEmail}. You cannot sign in again until you enter it, and
                until you do the login screen will only say your email or password is wrong.
              </p>
              {/* The one screen that accepts the code, linked from the one
                  screen that creates the need for it. Leaving this out is a
                  dead end exactly where a dead end costs the most: the person
                  is locked out and the copy has just told them so. */}
              <Link to="/verify-email" className="w-fit text-primary underline underline-offset-4">
                Enter the code now
              </Link>
            </div>
          ) : (
            <ConfirmAction
              label="Change email"
              ariaLabel="Change email address"
              destructive
              pending={changeEmail.isPending}
              error={emailError}
              onConfirm={confirmEmail}
              consequence={
                <>
                  Changing your address stops you being able to sign in. We send a code to{' '}
                  {newEmail || 'the new address'} and, until you enter it, the login screen will just
                  say your email or password is wrong — it will not tell you a code is waiting. Make
                  sure you can read mail at that address before you do this.
                </>
              }
            />
          )}
        </PanelBody>
      </Panel>
    </div>
  )
}
