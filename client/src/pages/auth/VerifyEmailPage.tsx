import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { AuthFrame } from '../../components/auth/AuthFrame.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { FormError } from '../../components/FormError.js'
import { verifyEmail } from '../../api/auth.js'
import { ApiError } from '../../lib/api.js'

export function VerifyEmailPage() {
  const location = useLocation()
  const initialEmail = (location.state as { email?: string } | null)?.email ?? ''
  const [email, setEmail] = useState(initialEmail)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await verifyEmail({ email, code })
      setVerified(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthFrame
      eyebrow="new account"
      title="Verify your email"
      step={verified ? 'Admin approval' : 'Confirm your email'}
    >
      {verified ? (
        // Step 3, and the only step the person cannot act on. It does end
        // by itself: the approve handler calls notify(), which writes the
        // in-app row AND emails them — so "we'll email you" is a promise
        // the server actually keeps, given SMTP is configured.
        <div className="flex flex-col gap-3">
          <p className="text-sm text-foreground">Email confirmed.</p>
          <p className="text-sm text-muted-foreground">
            One thing left, and it is not yours to do: an administrator on this instance has to approve
            your account. We&rsquo;ll email you the moment they do.
          </p>
          <p className="text-sm text-muted-foreground">
            Until then, signing in will keep saying your email or password is wrong. That is the approval
            waiting, not your password — nothing is broken and there is nothing to fix.
          </p>
          <Link to="/login" className="w-fit text-sm text-foreground underline">
            Go to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="verify-email">Email</Label>
            <Input id="verify-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="verify-code">Verification code</Label>
            <Input id="verify-code" value={code} onChange={(e) => setCode(e.target.value)} required />
          </div>
          <FormError message={error} />
          <Button type="submit" disabled={submitting}>
            Verify
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            <Link to="/login" className="text-foreground underline">
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </AuthFrame>
  )
}
