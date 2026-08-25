import { Navigate, Outlet, useLocation } from 'react-router'
import { useSession } from '../hooks/useSession.js'
import { GlobalSearch } from './search/GlobalSearch.js'

export function RequireAuth() {
  const session = useSession()
  const location = useLocation()

  if (session.isPending) return null
  if (session.isError) return <Navigate to="/login" replace />

  // MFA spec, "Enforcement": once an admin mandates it, anyone without an
  // authenticator is sent to set one up "before they can continue using the
  // instance". /settings is the one route that stays reachable — sending them
  // to enrolment and then refusing to render enrolment would be a closed loop.
  const mustEnrol =
    session.data.mfaRequired && !session.data.mfaEnabledAt && location.pathname !== '/settings'
  if (mustEnrol) return <Navigate to="/settings" replace />

  return (
    <>
      <Outlet />
      <GlobalSearch />
    </>
  )
}
