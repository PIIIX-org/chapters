import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { FormError } from '../../components/FormError.js'
import { signup } from '../../api/auth.js'
import { ApiError } from '../../lib/api.js'

export function SignupPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await signup({ email, password })
      navigate('/verify-email', { state: { email } })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display text-xl">Create an account</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="signup-email">Email</Label>
              <Input id="signup-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="signup-password">Password</Label>
              <Input
                id="signup-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </div>
            {/* Said here, and on verify-email, and deliberately NOT on the
                login screen: an unapproved account gets a generic "invalid
                credentials" there, because naming the real reason would tell
                a stranger whether an address has an account. Here the visitor
                is the one supplying the address, so there is nothing to leak
                — and without this they would wait on a wrong-password error
                forever with no idea what they were waiting for. */}
            <p className="text-sm text-muted-foreground">
              Two things happen before you can sign in: you confirm your email with a code, and an administrator
              on this instance approves your account. Sign-in keeps failing until both are done.
            </p>
            <FormError message={error} />
            <Button type="submit" disabled={submitting}>
              Sign up
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
