import { createBrowserRouter } from 'react-router'
import { RequireAuth } from './components/RequireAuth.js'
import { HomePage } from './pages/HomePage.js'
import { SetupPage } from './pages/auth/SetupPage.js'
import { SignupPage } from './pages/auth/SignupPage.js'
import { VerifyEmailPage } from './pages/auth/VerifyEmailPage.js'

export const router = createBrowserRouter([
  {
    element: <RequireAuth />,
    children: [{ path: '/', element: <HomePage /> }],
  },
  { path: '/setup', element: <SetupPage /> },
  { path: '/signup', element: <SignupPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
  { path: '/login', element: <div>Login page (Task 10)</div> },
])
