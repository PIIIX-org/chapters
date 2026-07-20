import { createBrowserRouter } from 'react-router'
import { RequireAuth } from './components/RequireAuth.js'
import { HomePage } from './pages/HomePage.js'
import { LoginPage } from './pages/auth/LoginPage.js'
import { RequestPasswordResetPage } from './pages/auth/RequestPasswordResetPage.js'
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage.js'
import { SetupPage } from './pages/auth/SetupPage.js'
import { SignupPage } from './pages/auth/SignupPage.js'
import { VerifyEmailPage } from './pages/auth/VerifyEmailPage.js'
import { VaultLayout } from './pages/vault/VaultLayout.js'
import { NoteEmptyState } from './pages/vault/NoteEmptyState.js'
import { NoteView } from './pages/vault/NoteView.js'

export const router = createBrowserRouter([
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <HomePage /> },
      {
        path: '/vaults/:vaultId',
        element: <VaultLayout />,
        children: [
          { index: true, element: <NoteEmptyState /> },
          { path: 'notes/*', element: <NoteView /> },
        ],
      },
    ],
  },
  { path: '/setup', element: <SetupPage /> },
  { path: '/signup', element: <SignupPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/forgot-password', element: <RequestPasswordResetPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
])
