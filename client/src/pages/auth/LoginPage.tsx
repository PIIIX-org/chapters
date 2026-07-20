import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { isMfaRequired, login } from '../../api/auth.js'
import { ApiError } from '../../lib/api.js'
import { SESSION_QUERY_KEY } from '../../hooks/useSession.js'

export function LoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [mfaChallenge, setMfaChallenge] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function attemptLogin(withTotp: boolean) {
    setError(null)
    setSubmitting(true)
    try {
      await login({ email, password, totp: withTotp ? totp : undefined })
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
      navigate('/')
    } catch (err) {
      if (isMfaRequired(err)) {
        setMfaChallenge(true)
      } else if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError('Something went wrong. Try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault()
    void attemptLogin(false)
  }

  function handleTotpSubmit(e: FormEvent) {
    e.preventDefault()
    void attemptLogin(true)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display text-xl">Log in</CardTitle>
        </CardHeader>
        <CardContent>
          {mfaChallenge ? (
            <form onSubmit={handleTotpSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="login-totp">Authentication code</Label>
                <Input id="login-totp" value={totp} onChange={(e) => setTotp(e.target.value)} required autoFocus />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting}>
                Verify code
              </Button>
            </form>
          ) : (
            <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="login-email">Email</Label>
                <Input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="login-password">Password</Label>
                <Input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting}>
                Log in
              </Button>
              <a href="/forgot-password" className="text-center text-sm text-muted-foreground underline">
                Forgot your password?
              </a>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
