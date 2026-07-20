import { createBrowserRouter } from 'react-router'
import { RequireAuth } from './components/RequireAuth.js'
import { HomePage } from './pages/HomePage.js'
import { SetupPage } from './pages/auth/SetupPage.js'

export const router = createBrowserRouter([
  {
    element: <RequireAuth />,
    children: [{ path: '/', element: <HomePage /> }],
  },
  { path: '/setup', element: <SetupPage /> },
  { path: '/login', element: <div>Login page (Task 10)</div> },
])
