import { Navigate, Outlet } from 'react-router'
import { useSession } from '../hooks/useSession.js'
import { GlobalSearch } from './search/GlobalSearch.js'

export function RequireAuth() {
  const session = useSession()

  if (session.isPending) return null
  if (session.isError) return <Navigate to="/login" replace />
  return (
    <>
      <Outlet />
      <GlobalSearch />
    </>
  )
}
