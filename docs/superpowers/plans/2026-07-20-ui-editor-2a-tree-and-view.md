# UI Slice 2a: Vault Tree + Read-Only Note View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in user see their accessible vaults, browse a vault's
file tree, and open a note to view its frontmatter and body — read-only,
no editing yet. This is the first of three sub-plans that together
implement UI Slice 2 (Editor, `docs/superpowers/specs/2026-07-09-editor-design.md`):
**2a** (this plan) gets note content on screen; **2b** adds CodeMirror 6
editing + the frontmatter property panel + autosave; **2c** adds
wikilinks. Each sub-plan produces working, testable software on its own.

**Architecture:** Three new routes nested under the existing `RequireAuth`
guard: `/` (now shows the vault list, replacing Slice 1's placeholder),
`/vaults/:vaultId` (file-tree layout + an empty state), and
`/vaults/:vaultId/notes/*` (read-only note content). Typed API modules
mirror the backend's own module boundaries (`api/vaults.ts` ↔
`server/src/vaults/routes.ts`, `api/notes.ts` ↔ `server/src/notes/routes.ts`),
same pattern Slice 1 used for `api/auth.ts`.

**Tech Stack:** Same as Slice 1 — React 19, TanStack Query, react-router
(library mode), Tailwind v4 + shadcn/ui. No new dependencies.

## Global Constraints

- Every backend route's request/response shape below was read verbatim
  from `server/src/vaults/routes.ts` and `server/src/notes/routes.ts` —
  exact, not inferred.
- pnpm only; strict + verbatimModuleSyntax TypeScript; Vitest tests
  import `describe`/`it`/`expect` explicitly (no globals); test
  environment is `happy-dom` globally (no per-file pragma needed).
- Note body is rendered as **raw markdown text** in this sub-plan (a
  monospace, pre-wrapped block), not rendered-to-HTML — real live-preview
  rendering is CodeMirror 6's job in 2b. Don't add a markdown-rendering
  dependency here; it would be replaced within one slice.
- No new route requires anything beyond `read` access — the backend
  itself enforces this (`resolveAccess` + `atLeast(access, 'read')`,
  returning 404 on insufficient access); the client does not duplicate
  this check, it just renders what the API returns.
- Anti-slop tooling (`impeccable`) fires automatically on file
  writes/edits — findings get fixed before a task's commit step.

---

### Task 1: Vault API functions

**Files:**
- Create: `client/src/api/vaults.ts`
- Create: `client/src/api/vaults.test.ts`

**Interfaces:**
- Consumes: `apiFetch` from `client/src/lib/api.js` (Slice 1, Task 4).
- Produces: `type VaultAccess = 'read' | 'edit' | 'owner'`, `interface Vault { id: string; name: string; ownerId: string; mergeable: boolean; access: VaultAccess }`, `function listVaults(): Promise<Vault[]>`, `function getVaultAccess(vaultId: string): Promise<{ access: VaultAccess }>`. Task 3 (VaultsPage) and Task 5 (VaultLayout) consume these.

- [ ] **Step 1: Write the failing tests**

`client/src/api/vaults.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { getVaultAccess, listVaults } from './vaults'

describe('vaults api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listVaults calls GET /api/vaults', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, [
        { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const vaults = await listVaults()

    expect(vaults).toEqual([
      { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' },
    ])
    expect(fetchMock).toHaveBeenCalledWith('/api/vaults', expect.objectContaining({ credentials: 'include' }))
  })

  it('getVaultAccess calls GET /api/vaults/:id/access', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { access: 'edit' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await getVaultAccess('v1')

    expect(result).toEqual({ access: 'edit' })
    expect(fetchMock).toHaveBeenCalledWith('/api/vaults/v1/access', expect.objectContaining({ credentials: 'include' }))
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `./vaults` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/api/vaults.ts`:
```ts
import { apiFetch } from '../lib/api.js'

export type VaultAccess = 'read' | 'edit' | 'owner'

export interface Vault {
  id: string
  name: string
  ownerId: string
  mergeable: boolean
  access: VaultAccess
}

export function listVaults(): Promise<Vault[]> {
  return apiFetch('/vaults')
}

export function getVaultAccess(vaultId: string): Promise<{ access: VaultAccess }> {
  return apiFetch(`/vaults/${vaultId}/access`)
}
```

- [ ] **Step 4: Run the tests, verify they pass; typecheck**

Run: `pnpm -C client test && pnpm -C client typecheck`
Expected: both pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/vaults.ts client/src/api/vaults.test.ts
git commit -m "Add typed vault API functions"
```

---

### Task 2: Note-read API functions

**Files:**
- Create: `client/src/api/notes.ts`
- Create: `client/src/api/notes.test.ts`

**Interfaces:**
- Consumes: `apiFetch` from `client/src/lib/api.js`.
- Produces: `interface NoteSummary { id: string; path: string; type: string; name: string; frontmatter: Record<string, unknown>; updatedAt: string }`, `type VaultTree = Record<string, NoteSummary[]>`, `function getVaultTree(vaultId: string): Promise<VaultTree>`, `interface NoteDetail { path: string; frontmatter: Record<string, unknown>; body: string; updatedAt: string }`, `function getNote(vaultId: string, path: string): Promise<NoteDetail>`. Task 4 (useVaultTree) and Task 6 (useNote) consume these.

- [ ] **Step 1: Write the failing tests**

`client/src/api/notes.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { getNote, getVaultTree } from './notes'

describe('notes api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getVaultTree calls GET /api/vaults/:id/tree', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, {
        people: [
          { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const tree = await getVaultTree('v1')

    expect(tree.people).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/vaults/v1/tree', expect.objectContaining({ credentials: 'include' }))
  })

  it('getNote calls GET /api/vaults/:id/notes/:path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, {
        path: 'people/jane',
        frontmatter: { type: 'people' },
        body: '# Jane\n\nNotes here.',
        updatedAt: '2026-01-01',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const note = await getNote('v1', 'people/jane')

    expect(note.body).toBe('# Jane\n\nNotes here.')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/notes/people/jane',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `./notes` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/api/notes.ts`:
```ts
import { apiFetch } from '../lib/api.js'

export interface NoteSummary {
  id: string
  path: string
  type: string
  name: string
  frontmatter: Record<string, unknown>
  updatedAt: string
}

export type VaultTree = Record<string, NoteSummary[]>

export function getVaultTree(vaultId: string): Promise<VaultTree> {
  return apiFetch(`/vaults/${vaultId}/tree`)
}

export interface NoteDetail {
  path: string
  frontmatter: Record<string, unknown>
  body: string
  updatedAt: string
}

export function getNote(vaultId: string, path: string): Promise<NoteDetail> {
  return apiFetch(`/vaults/${vaultId}/notes/${path}`)
}
```

- [ ] **Step 4: Run the tests, verify they pass; typecheck**

Run: `pnpm -C client test && pnpm -C client typecheck`
Expected: both pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/notes.ts client/src/api/notes.test.ts
git commit -m "Add typed note-read API functions"
```

---

### Task 3: `useVaults` hook + VaultsPage (replaces HomePage's placeholder)

**Files:**
- Create: `client/src/hooks/useVaults.ts`
- Modify: `client/src/pages/HomePage.tsx`
- Modify: `client/src/pages/HomePage.test.tsx`

**Interfaces:**
- Consumes: `listVaults`, `Vault` from Task 1.
- Produces: `function useVaults()` — `UseQueryResult<Vault[], ApiError>`, query key `['vaults']`. Task 5 (VaultLayout) reuses this same hook/key to look up a vault's name from cache.

- [ ] **Step 1: Write the failing test**

`client/src/pages/HomePage.test.tsx` — replace the file with this (adds vault-list coverage to the existing session-email and logout tests):
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../lib/api'
import { HomePage } from './HomePage'

function renderWithRouter() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/', element: <HomePage /> },
      { path: '/login', element: <div>Login page</div> },
    ],
    { initialEntries: ['/'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function stubFetch(vaults: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, vaults))
      if (url === '/api/logout') return Promise.resolve(mockJsonResponse(200, { status: 'logged_out' }))
      return Promise.resolve(
        mockJsonResponse(200, { id: 'u1', email: 'taha@piiix.org', status: 'active', role: 'member', createdAt: '2026-01-01' }),
      )
    }),
  )
}

describe('HomePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("greets the logged-in user's email", async () => {
    stubFetch([])
    renderWithRouter()

    await waitFor(() => expect(screen.getByText('taha@piiix.org')).toBeInTheDocument())
  })

  it('lists accessible vaults, linking to each one', async () => {
    stubFetch([{ id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' }])
    renderWithRouter()

    const link = await screen.findByRole('link', { name: 'Engineering' })
    expect(link).toHaveAttribute('href', '/vaults/v1')
  })

  it('shows an empty-state message when there are no vaults', async () => {
    stubFetch([])
    renderWithRouter()

    await waitFor(() => expect(screen.getByText('No vaults yet.')).toBeInTheDocument())
  })

  it('logs out and navigates to /login', async () => {
    stubFetch([])
    renderWithRouter()
    const user = userEvent.setup()

    await waitFor(() => expect(screen.getByText('taha@piiix.org')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Log out' }))

    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `useVaults` doesn't exist, `HomePage` doesn't render a vault list yet.

- [ ] **Step 3: Implement**

`client/src/hooks/useVaults.ts`:
```ts
import { useQuery } from '@tanstack/react-query'
import { listVaults } from '../api/vaults.js'
import type { ApiError } from '../lib/api.js'
import type { Vault } from '../api/vaults.js'

export const VAULTS_QUERY_KEY = ['vaults'] as const

export function useVaults() {
  return useQuery<Vault[], ApiError>({
    queryKey: VAULTS_QUERY_KEY,
    queryFn: listVaults,
  })
}
```

`client/src/pages/HomePage.tsx`:
```tsx
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { Button } from '../components/ui/button.js'
import { useSession, SESSION_QUERY_KEY } from '../hooks/useSession.js'
import { useVaults } from '../hooks/useVaults.js'
import { logout } from '../api/auth.js'

export function HomePage() {
  const session = useSession()
  const vaults = useVaults()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
    navigate('/login')
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-8 py-4">
        <span className="font-display text-xl">Chapters</span>
        {session.data && (
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{session.data.email}</span>
            <Button variant="secondary" onClick={() => void handleLogout()}>
              Log out
            </Button>
          </div>
        )}
      </header>
      <main className="flex-1 p-8">
        <h1 className="mb-6 font-display text-2xl">Vaults</h1>
        {vaults.data?.length === 0 && <p className="text-muted-foreground">No vaults yet.</p>}
        {vaults.data && vaults.data.length > 0 && (
          <ul className="flex flex-col gap-2">
            {vaults.data.map((vault) => (
              <li key={vault.id}>
                <Link to={`/vaults/${vault.id}`} className="text-primary underline">
                  {vault.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
```

- [ ] **Step 4: Run the tests, verify they pass; typecheck and build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm -C client build`
Expected: all pass/exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useVaults.ts client/src/pages/HomePage.tsx client/src/pages/HomePage.test.tsx
git commit -m "Add useVaults hook, show the vault list on HomePage"
```

---

### Task 4: `useVaultTree` hook + `FileTree` component

**Files:**
- Create: `client/src/hooks/useVaultTree.ts`
- Create: `client/src/components/vault/FileTree.tsx`
- Create: `client/src/components/vault/FileTree.test.tsx`

**Interfaces:**
- Consumes: `getVaultTree`, `VaultTree`, `NoteSummary` from Task 2.
- Produces: `function useVaultTree(vaultId: string)` — `UseQueryResult<VaultTree, ApiError>`, query key `['vault-tree', vaultId]`. `FileTree` component — props `{ vaultId: string; tree: VaultTree }`, renders type-grouped, clickable note links. Task 5 (VaultLayout) composes both.

- [ ] **Step 1: Write the failing test**

`client/src/components/vault/FileTree.test.tsx`:
```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { FileTree } from './FileTree'
import type { VaultTree } from '../../api/notes'

function renderTree(tree: VaultTree) {
  const router = createMemoryRouter([{ path: '/', element: <FileTree vaultId="v1" tree={tree} /> }])
  render(<RouterProvider router={router} />)
}

describe('FileTree', () => {
  it('groups notes by type and links each one to its note path', () => {
    renderTree({
      people: [
        { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' },
      ],
      projects: [
        { id: 'n2', path: 'projects/roadmap', type: 'projects', name: 'roadmap', frontmatter: {}, updatedAt: '2026-01-01' },
      ],
    })

    expect(screen.getByText('people')).toBeInTheDocument()
    expect(screen.getByText('projects')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'jane' })
    expect(link).toHaveAttribute('href', '/vaults/v1/notes/people/jane')
  })

  it('renders nothing but the container when the tree is empty', () => {
    renderTree({})
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `./FileTree` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/hooks/useVaultTree.ts`:
```ts
import { useQuery } from '@tanstack/react-query'
import { getVaultTree } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { VaultTree } from '../api/notes.js'

export function useVaultTree(vaultId: string) {
  return useQuery<VaultTree, ApiError>({
    queryKey: ['vault-tree', vaultId],
    queryFn: () => getVaultTree(vaultId),
  })
}
```

`client/src/components/vault/FileTree.tsx`:
```tsx
import { Link } from 'react-router'
import type { VaultTree } from '../../api/notes.js'

interface FileTreeProps {
  vaultId: string
  tree: VaultTree
}

export function FileTree({ vaultId, tree }: FileTreeProps) {
  return (
    <nav>
      {Object.entries(tree).map(([type, notes]) => (
        <div key={type} className="mb-4">
          <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">{type}</div>
          {notes.map((note) => (
            <Link
              key={note.id}
              to={`/vaults/${vaultId}/notes/${note.path}`}
              className="block truncate rounded px-2 py-1 text-sm hover:bg-muted"
            >
              {note.name}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}
```

- [ ] **Step 4: Run the tests, verify they pass; typecheck**

Run: `pnpm -C client test && pnpm -C client typecheck`
Expected: both pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useVaultTree.ts client/src/components/vault/
git commit -m "Add useVaultTree hook and FileTree component"
```

---

### Task 5: `VaultLayout` (sidebar + breadcrumb shell) + router wiring

**Files:**
- Create: `client/src/pages/vault/VaultLayout.tsx`
- Create: `client/src/pages/vault/VaultLayout.test.tsx`
- Create: `client/src/pages/vault/NoteEmptyState.tsx`
- Modify: `client/src/router.tsx`

**Interfaces:**
- Consumes: `useVaults` (Task 3, for the vault's display name), `useVaultTree` + `FileTree` (Task 4).
- Produces: renders `<Outlet context={vault} />` where `vault: Vault | undefined` (Task 1's `Vault` type) — Task 6 (`NoteView`) reads this via `useOutletContext<Vault | undefined>()` for the breadcrumb.

- [ ] **Step 1: Write the failing test**

`client/src/pages/vault/VaultLayout.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { VaultLayout } from './VaultLayout'

function renderLayout() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/vaults/:vaultId',
        element: <VaultLayout />,
        children: [{ index: true, element: <div>Empty state</div> }],
      },
    ],
    { initialEntries: ['/vaults/v1'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('VaultLayout', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the file tree in the sidebar and the outlet content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === '/api/vaults') {
          return Promise.resolve(
            mockJsonResponse(200, [{ id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' }]),
          )
        }
        return Promise.resolve(
          mockJsonResponse(200, {
            people: [
              { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' },
            ],
          }),
        )
      }),
    )

    renderLayout()

    await waitFor(() => expect(screen.getByRole('link', { name: 'jane' })).toBeInTheDocument())
    expect(screen.getByText('Empty state')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Vaults' })).toHaveAttribute('href', '/')
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `./VaultLayout` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/pages/vault/NoteEmptyState.tsx`:
```tsx
export function NoteEmptyState() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      Select a note from the sidebar.
    </div>
  )
}
```

`client/src/pages/vault/VaultLayout.tsx`:
```tsx
import { Link, Outlet, useParams } from 'react-router'
import { useVaults } from '../../hooks/useVaults.js'
import { useVaultTree } from '../../hooks/useVaultTree.js'
import { FileTree } from '../../components/vault/FileTree.js'

export function VaultLayout() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const vaults = useVaults()
  const tree = useVaultTree(vaultId!)
  const vault = vaults.data?.find((v) => v.id === vaultId)

  return (
    <div className="flex min-h-screen">
      <aside className="w-[220px] shrink-0 border-r border-border bg-secondary p-4">
        <Link to="/" className="mb-4 block text-sm text-muted-foreground underline">
          ← Vaults
        </Link>
        {tree.data && <FileTree vaultId={vaultId!} tree={tree.data} />}
      </aside>
      <div className="flex-1">
        <Outlet context={vault} />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Wire the routes**

`client/src/router.tsx` — add the import for `VaultLayout` and `NoteEmptyState`, and nest a new entry inside the existing `RequireAuth`-wrapped `children` array, alongside `{ path: '/', element: <HomePage /> }`:
```tsx
      {
        path: '/vaults/:vaultId',
        element: <VaultLayout />,
        children: [{ index: true, element: <NoteEmptyState /> }],
      },
```

- [ ] **Step 5: Run the tests, verify they pass; typecheck and build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm -C client build`
Expected: all pass/exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/vault/ client/src/router.tsx
git commit -m "Add VaultLayout with file-tree sidebar and empty state"
```

---

### Task 6: `useNote` hook + `NoteView` (read-only note content)

**Files:**
- Create: `client/src/hooks/useNote.ts`
- Create: `client/src/pages/vault/NoteView.tsx`
- Create: `client/src/pages/vault/NoteView.test.tsx`
- Modify: `client/src/router.tsx`

**Interfaces:**
- Consumes: `getNote`, `NoteDetail` from Task 2; the `Vault | undefined` outlet context from Task 5.
- Produces: `function useNote(vaultId: string, path: string)` — `UseQueryResult<NoteDetail, ApiError>`, query key `['note', vaultId, path]`.

- [ ] **Step 1: Write the failing test**

`client/src/pages/vault/NoteView.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { NoteView } from './NoteView'

function renderNote(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [{ path: '/vaults/:vaultId/notes/*', element: <NoteView /> }],
    { initialEntries: [initialPath] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('NoteView', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the frontmatter and body of the selected note', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, {
          path: 'people/jane',
          frontmatter: { type: 'people', timestamp: '2026-01-01T00:00:00.000Z' },
          body: '# Jane\n\nNotes about Jane.',
          updatedAt: '2026-01-01',
        }),
      ),
    )

    renderNote('/vaults/v1/notes/people/jane')

    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    expect(screen.getByText('type:')).toBeInTheDocument()
    expect(screen.getByText('# Jane\n\nNotes about Jane.')).toBeInTheDocument()
  })

  it('shows a not-found message for a missing note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(404, { error: 'note not found' })))

    renderNote('/vaults/v1/notes/people/ghost')

    await waitFor(() => expect(screen.getByText('Note not found.')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `./NoteView` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/hooks/useNote.ts`:
```ts
import { useQuery } from '@tanstack/react-query'
import { getNote } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { NoteDetail } from '../api/notes.js'

export function useNote(vaultId: string, path: string) {
  return useQuery<NoteDetail, ApiError>({
    queryKey: ['note', vaultId, path],
    queryFn: () => getNote(vaultId, path),
    enabled: Boolean(vaultId && path),
  })
}
```

`client/src/pages/vault/NoteView.tsx`:
```tsx
import { useOutletContext, useParams } from 'react-router'
import { useNote } from '../../hooks/useNote.js'
import type { Vault } from '../../api/vaults.js'

export function NoteView() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const path = useParams()['*']
  const vault = useOutletContext<Vault | undefined>()
  const note = useNote(vaultId!, path!)

  if (note.isPending) return null
  if (note.isError) return <div className="p-8 text-muted-foreground">Note not found.</div>

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-8 py-4 text-sm text-muted-foreground">
        {(vault?.name ?? vaultId) + ' / ' + note.data!.path}
      </div>
      <div className="border-b border-border px-8 py-4">
        <dl className="flex flex-col gap-1 text-sm">
          {Object.entries(note.data!.frontmatter).map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="font-medium text-muted-foreground">{key}:</dt>
              <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <pre className="flex-1 overflow-auto whitespace-pre-wrap p-8 font-mono text-sm">{note.data!.body}</pre>
    </div>
  )
}
```

- [ ] **Step 4: Wire the route**

`client/src/router.tsx` — add the `NoteView` import, and add `{ path: 'notes/*', element: <NoteView /> }` to the `/vaults/:vaultId` route's `children` array, alongside the existing `{ index: true, element: <NoteEmptyState /> }`:
```tsx
      {
        path: '/vaults/:vaultId',
        element: <VaultLayout />,
        children: [
          { index: true, element: <NoteEmptyState /> },
          { path: 'notes/*', element: <NoteView /> },
        ],
      },
```

- [ ] **Step 5: Run the tests, verify they pass; typecheck and build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm -C client build`
Expected: all pass/exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/useNote.ts client/src/pages/vault/NoteView.tsx client/src/pages/vault/NoteView.test.tsx client/src/router.tsx
git commit -m "Add useNote hook and read-only NoteView"
```

---

### Task 7: Final verification, README/STATE.md update

**Files:**
- Modify: `README.md`
- Modify: `docs/agents/STATE.md`

**Interfaces:** none — docs only.

- [ ] **Step 1: Run full verification**

Run:
```bash
cd ~/Documents/chapters
pnpm typecheck
pnpm lint
pnpm -r test
pnpm -C client build
```
Expected: all exit 0. Client test count should be 35 (Slice 1) + roughly 11 new (2 vaults-api + 2 notes-api + 4 HomePage + 2 FileTree + 1 VaultLayout + 2 NoteView) = ~46.

- [ ] **Step 2: Update README.md**

In the paragraph added by Slice 1's Task 13 (the one starting "The frontend (`client/`) is a Vite + React app..."), append one sentence:
```markdown
 Logged-in users can now browse their vaults and view notes read-only
(`/vaults/:id`, `/vaults/:id/notes/*`) — editing arrives in the next
UI sub-plan.
```

- [ ] **Step 3: Update STATE.md**

Read the current `docs/agents/STATE.md`, update the "Current task"/"Next step" bullets to reflect that Slice 2a (vault tree + read-only note view) is done and Slice 2b (CodeMirror 6 editing) is next — keep the file at or under 40 lines, trimming older detail if needed.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/agents/STATE.md
git commit -m "Update README and STATE.md for Slice 2a"
```

---

## Self-Review

**Spec coverage:** `2026-07-09-editor-design.md`'s "Layout" section's sidebar file tree and property-panel display are both covered (Tasks 4-6); the CodeMirror 6 live-preview body, note create/edit/rename/delete lifecycle, and permission-aware editing lock are explicitly deferred to 2b (noted in Global Constraints); wikilinks are explicitly deferred to 2c. This sub-plan's own scope — read-only browse-and-view — is fully covered.

**Placeholder scan:** no TBD/TODO; every step has complete, runnable code.

**Type consistency:** `Vault` (Task 1) is imported by name in Task 5/6, never redefined. `VaultTree`/`NoteSummary`/`NoteDetail` (Task 2) are imported by name in Tasks 4/5/6, never redefined. `VAULTS_QUERY_KEY` (Task 3) is available for reuse but Task 5 calls `useVaults()` directly rather than needing the raw key — consistent, no drift.

## Sub-plans still to come (scoped, not detailed — write in full when started)

- **2b — CodeMirror 6 editing.** Replace `NoteView`'s read-only `<pre>` body
  with a real CodeMirror 6 instance (live-preview markdown: typed syntax
  renders inline rather than showing raw characters at rest, per the
  spec). Add the frontmatter property panel as typed fields (dropdown for
  `type`, chip input for `tags`, etc. — never raw YAML), wired to
  `PUT /vaults/:id/notes/*`. Add debounced autosave (no explicit save
  action). Add create (type-first flow → `POST /vaults/:id/notes`),
  rename (`POST /vaults/:id/notes-rename`), and soft-delete
  (`DELETE /vaults/:id/notes/*`) from the file tree. Add the
  permission-aware lock: `read`-only access (from `getVaultAccess`,
  Task 1) disables the property panel, autosave, and
  create/rename/delete affordances entirely — `edit`/`owner` gets the
  full editor. New dependency: CodeMirror 6 packages
  (`@codemirror/state`, `@codemirror/view`, `@codemirror/lang-markdown`,
  a livePreview/decorations extension) — pick and justify the exact
  package set when this sub-plan is written, don't assume now.
- **2c — Wikilinks.** `[[` autocomplete against `getVaultTree`'s already-
  fetched note list (no new endpoint). Rendered `[[link]]` in live-preview
  mode is clickable and navigates via `react-router`'s `navigate()`.
  Clicking a link to a note that doesn't exist creates it (2b's create
  flow, invoked programmatically) — infer `type` from context where
  possible, otherwise fall back to 2b's type-first creation UI. Depends
  on 2b's live-preview CodeMirror instance existing first (wikilinks are
  rendered/interactive inside it).
