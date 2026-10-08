import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { AuthFrame } from '../../components/auth/AuthFrame.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { requestPasswordReset } from '../../api/auth.js'

export function RequestPasswordResetPage() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await requestPasswordReset(email)
    } catch {
      // Swallow — anti-enumeration means we never branch on success vs failure.
    } finally {
      // Always show the same confirmation, success or failure — no enumeration.
      setSubmitted(true)
      setSubmitting(false)
    }
  }

  return (
    <AuthFrame eyebrow="password reset" title="Reset your password">
      {submitted ? (
        <p className="text-sm text-muted-foreground">
          If an account exists for that email, a reset link is on its way.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reset-request-email">Email</Label>
            <Input
              id="reset-request-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="rounded-[var(--radius-sm,2px)]"
            />
          </div>
          <Button type="submit" disabled={submitting} className="w-full min-h-[40px] sm:min-h-9 rounded-[var(--radius-sm,2px)] touch-manipulation">
            Send reset link
          </Button>
          <p className="text-center text-sm text-muted-foreground py-0.5">
            <Link to="/login" className="text-foreground underline underline-offset-4 py-1 touch-manipulation hover:text-primary transition-colors">
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </AuthFrame>
  )
}
