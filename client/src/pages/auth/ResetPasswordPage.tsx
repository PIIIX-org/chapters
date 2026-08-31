import { useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { AuthFrame } from '../../components/auth/AuthFrame.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { FormError } from '../../components/FormError.js'
import { resetPassword } from '../../api/auth.js'
import { ApiError } from '../../lib/api.js'

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await resetPassword(token, password)
      navigate('/login')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthFrame eyebrow="password reset" title="Choose a new password">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reset-password">New password</Label>
          <Input
            id="reset-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </div>
        <FormError message={error} />
        <Button type="submit" disabled={submitting}>
          Reset password
        </Button>
      </form>
    </AuthFrame>
  )
}
