import { useState, type FormEvent } from 'react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { SecretReveal } from '../ui/SecretReveal.js'
import { FormError } from '../FormError.js'
import { useDisableMfa, useEnableMfa, useStartMfaSetup } from '../../hooks/useAccount.js'
import { useSession } from '../../hooks/useSession.js'

const turnedOn = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

function formatDate(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '—' : turnedOn.format(parsed)
}

/**
 * TOTP enrolment, backup codes, and — only when the instance does not mandate
 * it — turning it off again.
 *
 * No QR image: nothing in this client renders one, and every authenticator app
 * takes the key typed in or the otpauth:// URI opened on the device, so the
 * dependency would buy convenience on one screen and nothing else.
 */
export function MfaSection() {
  const session = useSession()
  const start = useStartMfaSetup()
  const enable = useEnableMfa()
  const disable = useDisableMfa()
  const [code, setCode] = useState('')
  const [disabling, setDisabling] = useState(false)
  // Held in state and nowhere else: no storage, no query cache, no URL. Gone
  // from the tree the moment SecretReveal is dismissed.
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)

  // isError before .data: a failed /me must not render as "two-factor is off",
  // which is an answer, and the wrong one.
  if (session.isPending) {
    return <p className="text-sm text-muted-foreground">Loading your security settings…</p>
  }
  if (session.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {session.error.message}
      </p>
    )
  }

  const { mfaEnabledAt, mfaRequired } = session.data

  // `enable.isSuccess` is part of this, not decoration. The mutation flips
  // mfaEnabledAt server-side, but the session only catches up on an async
  // refetch — and in that window a branch gated on mfaEnabledAt alone renders
  // the not-enrolled panel *underneath the freshly issued backup codes*,
  // complete with a live "Set up two-factor authentication" button. That
  // button POSTs /mfa/setup, which clears mfaEnabledAt and issues a new
  // secret: one click and the user is silently un-enrolled, holding codes that
  // no longer work.
  const enrolled = Boolean(mfaEnabledAt) || enable.isSuccess

  function handleEnable(e: FormEvent) {
    e.preventDefault()
    enable.mutate(code, {
      onSuccess: (result) => {
        setBackupCodes(result.backupCodes)
        setCode('')
        // Drop the pending secret from the tree once it is enrolled; it has no
        // second use, and the panel it lives in is finished with.
        start.reset()
      },
    })
  }

  function handleDisable(e: FormEvent) {
    e.preventDefault()
    disable.mutate(code, {
      onSuccess: () => {
        setCode('')
        setDisabling(false)
      },
    })
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-display text-lg text-foreground">Two-factor authentication</h2>

      {backupCodes && (
        // ponytail: one string, newline-separated, so Copy puts one code per
        // line on the clipboard. SecretReveal is shared with MCP tokens and is
        // not mine to reflow; if the single-line display ever bothers anyone,
        // that is a change to SecretReveal, not a second reveal component.
        <SecretReveal
          label={`Your ${backupCodes.length} backup codes`}
          secret={backupCodes.join('\n')}
          note="Keep these somewhere other than the phone your authenticator app is on. If you lose that device, a backup code is the only way back into your account. Each one works once, and they will not be shown again."
          onDismiss={() => setBackupCodes(null)}
        />
      )}

      {enrolled ? (
        <>
          <p className="text-sm text-foreground">
            On. Signing in asks for a code from your authenticator app after your password.
          </p>
          {mfaEnabledAt && (
            <p className="font-mono text-xs text-muted-foreground">
              Turned on {formatDate(mfaEnabledAt)}
            </p>
          )}
          {mfaRequired ? (
            // State C. The server 403s a disable while the mandate is on, so
            // there is no control here at all — a button that always fails is
            // worse than no button.
            <p className="text-sm text-muted-foreground">
              An admin requires two-factor authentication on this instance, so it cannot be turned
              off from here.
            </p>
          ) : disabling ? (
            <form
              onSubmit={handleDisable}
              className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3"
            >
              <p className="text-sm text-muted-foreground">
                Turning this off means signing in stops asking for a second factor — your password
                alone gets into your account. Your existing backup codes stop working, and setting
                it up again issues a new key and a new set of codes.
              </p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mfa-disable-code">
                  Code from your authenticator app, or one of your backup codes
                </Label>
                <Input
                  id="mfa-disable-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  required
                  autoFocus
                />
              </div>
              <FormError message={disable.error?.message ?? null} />
              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" variant="destructive" disabled={disable.isPending}>
                  Turn off two-factor authentication
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDisabling(false)
                    setCode('')
                    disable.reset()
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="w-fit"
              aria-label="Disable two-factor authentication"
              onClick={() => setDisabling(true)}
            >
              Disable
            </Button>
          )}
        </>
      ) : start.data ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            Add Chapters to your authenticator app, either by typing the key in or by opening the
            link below on the device the app is on. Then enter the 6-digit code it shows.
          </p>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Setup key</span>
            <code className="overflow-x-auto rounded border border-border bg-muted px-2 py-1 font-mono text-sm break-all text-foreground">
              {start.data.secret}
            </code>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Or open this link on that device</span>
            <a
              href={start.data.uri}
              className="overflow-x-auto rounded border border-border bg-muted px-2 py-1 font-mono text-xs break-all text-foreground underline"
            >
              {start.data.uri}
            </a>
          </div>
          <form onSubmit={handleEnable} className="flex flex-col gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mfa-enable-code">6-digit code from your authenticator app</Label>
              <Input
                id="mfa-enable-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </div>
            <FormError message={enable.error?.message ?? null} />
            <Button type="submit" size="sm" className="w-fit" disabled={enable.isPending}>
              Turn on two-factor authentication
            </Button>
          </form>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {mfaRequired
              ? 'An admin requires two-factor authentication on this instance. Set it up to carry on using Chapters.'
              : 'Off. Signing in asks for your password and nothing else.'}
          </p>
          <FormError message={start.error?.message ?? null} />
          <Button
            type="button"
            size="sm"
            className="w-fit"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            Set up two-factor authentication
          </Button>
        </>
      )}
    </section>
  )
}
