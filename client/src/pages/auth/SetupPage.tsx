import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { FormError } from '../../components/FormError.js'
import { setupInstance } from '../../api/auth.js'
import { ApiError } from '../../lib/api.js'
import { SESSION_QUERY_KEY } from '../../hooks/useSession.js'

export function SetupPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [token, setToken] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [alreadySetUp, setAlreadySetUp] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setAlreadySetUp(false)
    setSubmitting(true)
    try {
      await setupInstance({ token, email, password })
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
      navigate('/')
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setAlreadySetUp(true)
      } else if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError('Something went wrong. Try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display text-xl">Set up Chapters</CardTitle>
        </CardHeader>
        <CardContent>
          {alreadySetUp ? (
            <p className="text-sm text-muted-foreground">
              This instance is already set up. Go to <a href="/login" className="text-primary underline">login</a>.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-token">Setup token</Label>
                <Input id="setup-token" value={token} onChange={(e) => setToken(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-email">Email</Label>
                <Input id="setup-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-password">Password</Label>
                <Input
                  id="setup-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  required
                />
              </div>
              <FormError message={error} />
              <Button type="submit" disabled={submitting}>
                Create admin account
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
