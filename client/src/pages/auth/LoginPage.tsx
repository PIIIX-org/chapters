import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AuthFrame } from '../../components/auth/AuthFrame.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { FormError } from '../../components/FormError.js'
import { getAuthConfig, isMfaRequired, login } from '../../api/auth.js'
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
  // What doors this instance offers. Until the answer arrives, render the
  // password form — the wrong guess is a flash, not a lockout.
  const { data: authConfig } = useQuery({ queryKey: ['auth-config'], queryFn: getAuthConfig })
  const [searchParams] = useSearchParams()
  const ssoFailed = searchParams.get('error') === 'sso'

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
        // withTotp means this was a retry with a code already entered, so mfaRequired here
        // means the code was wrong, not that we're seeing the prompt for the first time.
        if (withTotp) setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
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
    <AuthFrame eyebrow="sign in" title="Log in">
      {authConfig?.oidc ? (
        <div className="mb-4 flex flex-col gap-4">
          {ssoFailed ? <FormError message="Single sign-on failed. Try again." /> : null}
          <Button asChild>
            <a href="/api/oidc/login">Continue with single sign-on</a>
          </Button>
          {!authConfig.oidcOnly && (
            <p className="text-center text-sm text-muted-foreground">or use your password</p>
          )}
        </div>
      ) : null}
      {authConfig?.oidcOnly ? null : mfaChallenge ? (
        <form onSubmit={handleTotpSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-totp">Authentication code</Label>
            <Input id="login-totp" value={totp} onChange={(e) => setTotp(e.target.value)} required autoFocus />
          </div>
          <FormError message={error} />
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
          <FormError message={error} />
          <Button type="submit" disabled={submitting}>
            Log in
          </Button>
          <Link to="/forgot-password" className="text-center text-sm text-muted-foreground underline">
            Forgot your password?
          </Link>
          {/* Until this existed there was no route to sign-up anywhere in
              the app — a new person could only reach it by typing the URL.
              Same cold-start trap as vault creation and connecting a
              repository: a surface reachable only from somewhere you can
              only get to if you already have what it creates. */}
          <p className="text-center text-sm text-muted-foreground">
            New here?{' '}
            <Link to="/signup" className="text-foreground underline">
              Create an account
            </Link>
          </p>
        </form>
      )}
    </AuthFrame>
  )
}
