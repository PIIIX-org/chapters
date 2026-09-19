import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { AuthFrame } from '../../components/auth/AuthFrame.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { FormError } from '../../components/FormError.js'
import { verifyEmail } from '../../api/auth.js'
import { ApiError } from '../../lib/api.js'

export function VerifyEmailPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const initialEmail = (location.state as { email?: string } | null)?.email ?? ''
  const [email, setEmail] = useState(initialEmail)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await verifyEmail({ email, code })
      navigate('/pending-approval', { state: { email } })
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
      step="Confirm your email"
    >
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
    </AuthFrame>
  )
}
