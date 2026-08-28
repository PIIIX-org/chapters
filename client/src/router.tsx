import { lazy, Suspense } from 'react'
import { createBrowserRouter, type RouteObject } from 'react-router'
import { RequireAuth } from './components/RequireAuth.js'
import { HomePage } from './pages/HomePage.js'
import { GraphSkeleton } from './components/graph/GraphSkeleton.js'
import { LoginPage } from './pages/auth/LoginPage.js'
import { RequestPasswordResetPage } from './pages/auth/RequestPasswordResetPage.js'
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage.js'
import { SetupPage } from './pages/auth/SetupPage.js'
import { SignupPage } from './pages/auth/SignupPage.js'
import { VerifyEmailPage } from './pages/auth/VerifyEmailPage.js'
import { NoteEmptyState } from './pages/vault/NoteEmptyState.js'

// Lazy at the route level, not just the graph: VaultLayout pulls in the file
// tree + note-create UI, and NoteView pulls in the whole CodeMirror/@lezer
// editor stack. Home never renders either, so neither belongs in the entry
// chunk — same reasoning as GraphCanvas in HomePage.tsx, applied one level up.
const VaultLayout = lazy(() => import('./pages/vault/VaultLayout.js').then((m) => ({ default: m.VaultLayout })))
const NoteView = lazy(() => import('./pages/vault/NoteView.js').then((m) => ({ default: m.NoteView })))
// Same reasoning as VaultLayout/NoteView above: Home never renders this, so
// it doesn't belong in the entry chunk.
const TeamPage = lazy(() => import('./pages/TeamPage.js').then((m) => ({ default: m.TeamPage })))
// Same again, and doubly so: most people on an instance are not admins and
// will never load this chunk at all.
const AdminPage = lazy(() => import('./pages/AdminPage.js').then((m) => ({ default: m.AdminPage })))
// Home never renders settings either, and an unenrolled user on an
// MFA-mandating instance is sent straight here — one lazy chunk, not part of
// the entry bundle.
const SettingsPage = lazy(() => import('./pages/SettingsPage.js').then((m) => ({ default: m.SettingsPage })))
// And again, hardest of all: this one pulls in a second CodeMirror stack (the
// read-only code viewer) for people who have connected a repository at all.
const RepositoryPage = lazy(() =>
  import('./pages/RepositoryPage.js').then((m) => ({ default: m.RepositoryPage })),
)

/**
 * Exported separately from `router` so a test can mount the real route table
 * in a memory router: `createBrowserRouter` binds to `window.location` when
 * it is created (at import), which leaves no way to start a test anywhere but
 * `/`. The app still gets exactly these routes.
 */
export const routes: RouteObject[] = [
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <HomePage /> },
      {
        path: '/team',
        element: (
          <Suspense fallback={<GraphSkeleton />}>
            <TeamPage />
          </Suspense>
        ),
      },
      {
        path: '/settings',
        element: (
          <Suspense fallback={<GraphSkeleton />}>
            <SettingsPage />
          </Suspense>
        ),
      },
      {
        path: '/admin',
        element: (
          <Suspense fallback={<GraphSkeleton />}>
            <AdminPage />
          </Suspense>
        ),
      },
      {
        // Splat, not a nested `:path` param: a file path has arbitrary depth
        // and keeps its slashes. It also matches `/repos/:id/files` with an
        // empty splat, which is the no-file-chosen state the page renders.
        path: '/repos/:id/files/*',
        element: (
          <Suspense fallback={<GraphSkeleton />}>
            <RepositoryPage />
          </Suspense>
        ),
      },
      {
        path: '/vaults/:vaultId',
        element: (
          <Suspense fallback={<GraphSkeleton />}>
            <VaultLayout />
          </Suspense>
        ),
        children: [
          { index: true, element: <NoteEmptyState /> },
          {
            path: 'notes/*',
            element: (
              <Suspense fallback={<GraphSkeleton />}>
                <NoteView />
              </Suspense>
            ),
          },
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
]

export const router = createBrowserRouter(routes)
