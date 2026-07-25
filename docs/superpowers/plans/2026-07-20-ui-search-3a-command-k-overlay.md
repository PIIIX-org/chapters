# UI Slice 3a: Search — ⌘K Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global ⌘K search overlay: press ⌘K (or Ctrl+K) anywhere in the app to
open a search box, type a query, and click a matching note to jump to it.

**Architecture:** A `search()` API client + `useSearch(query)` TanStack Query
hook over the backend's hybrid keyword+semantic `GET /search`, a controlled
`SearchOverlay` component (debounced input → results → click-to-navigate), and a
`GlobalSearch` wrapper (owns open state + the ⌘K/Escape key listener) mounted in
`RequireAuth` so it's available on every authenticated page.

**Tech Stack:** existing `apiFetch`/TanStack Query/React Router; the existing
`Input` primitive + design tokens. No new dependency.

## Global Constraints

- **Backend search contract (read verbatim from `server/src/search/routes.ts` +
  `search.ts`):** `GET /search?q=<query>&limit=<n>` (auth-required; searches every
  vault + repository the caller can reach, permission-filtered in-query) →
  `SearchResult[]` where `SearchResult = { resourceType: 'note' | 'code'; id:
  string; containerId: string; path: string; frontmatter?: unknown; language?:
  string | null; snippet: string; score: number }`. `q` is 1–500 chars; `limit`
  1–100, default 20. There's also a per-vault `GET /vaults/:id/search` — this
  slice uses the global `/search` for ⌘K.
- **Scope:** navigate **note** results only (`resourceType === 'note'` →
  `/vaults/${containerId}/notes/${path}`). Code results (from repositories) are
  filtered out of the list — the client has no code-file viewer yet; surfacing
  code results is deferred. Keyboard navigation (arrow keys) is the next
  increment (3b); this slice is mouse-driven + Esc-to-close.
- **Debounce** the input (~250ms) before it hits `useSearch`, so typing doesn't
  fire a request per keystroke (hand-rolled `setTimeout`, no new dep, like the
  editor's autosave).
- `q` must be URL-encoded in the request.
- pnpm; strict TS + `verbatimModuleSyntax`; Vitest explicit imports; happy-dom;
  existing `Input` primitive + design tokens (`bg-background`, `border-border`,
  `text-muted-foreground`, `bg-muted`, etc.) — no invented colors. Root
  `pnpm lint` clean before each commit. No `_`-prefixed unused vars.
- Anti-slop tooling (`impeccable`) fires on writes/edits — fix findings first.

---

### Task 1: `search` API client

**Files:**
- Create: `client/src/api/search.ts`
- Create: `client/src/api/search.test.ts`

**Interfaces:**
- Produces: `interface SearchResult { resourceType: 'note' | 'code'; id: string; containerId: string; path: string; snippet: string; score: number }`,
  `function search(query: string, limit?: number): Promise<SearchResult[]>`.
  Task 2 consumes these.

- [ ] **Step 1: Write the failing test**

`client/src/api/search.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { search } from './search'

describe('search api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GETs /api/search with the url-encoded query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, [
        { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'people/jane', snippet: '…jane…', score: 0.9 },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const results = await search('jane doe', 10)

    expect(results[0]!.path).toBe('people/jane')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/search?q=jane%20doe&limit=10',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `pnpm -C client test -- api/search`
Expected: FAIL — `./search` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/api/search.ts`:
```ts
import { apiFetch } from '../lib/api.js'

export interface SearchResult {
  resourceType: 'note' | 'code'
  id: string
  containerId: string
  path: string
  snippet: string
  score: number
}

export function search(query: string, limit = 20): Promise<SearchResult[]> {
  return apiFetch(`/search?q=${encodeURIComponent(query)}&limit=${limit}`)
}
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm -C client test -- api/search && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/search.ts client/src/api/search.test.ts
git commit -m "Add search API client"
```

---

### Task 2: `useSearch` hook

**Files:**
- Create: `client/src/hooks/useSearch.ts`
- Create: `client/src/hooks/useSearch.test.tsx`

**Interfaces:**
- Consumes: `search`, `SearchResult` (Task 1).
- Produces: `useSearch(query: string)` — `useQuery<SearchResult[], ApiError>`,
  key `['search', query]`, `enabled: query.trim().length > 0` (empty query → no
  request, `data` undefined). Task 3 consumes it.

- [ ] **Step 1: Write the failing test**

`client/src/hooks/useSearch.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useSearch } from './useSearch'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useSearch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not fetch for an empty query', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderHook(() => useSearch('   '), { wrapper })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches results for a non-empty query', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, [{ resourceType: 'note', id: 'n1', containerId: 'v1', path: 'people/jane', snippet: 's', score: 1 }]),
      ),
    )
    const { result } = renderHook(() => useSearch('jane'), { wrapper })
    await waitFor(() => expect(result.current.data?.[0]?.path).toBe('people/jane'))
  })
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `pnpm -C client test -- useSearch`
Expected: FAIL — `./useSearch` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/hooks/useSearch.ts`:
```ts
import { useQuery } from '@tanstack/react-query'
import { search } from '../api/search.js'
import type { ApiError } from '../lib/api.js'
import type { SearchResult } from '../api/search.js'

export function useSearch(query: string) {
  return useQuery<SearchResult[], ApiError>({
    queryKey: ['search', query],
    queryFn: () => search(query),
    enabled: query.trim().length > 0,
  })
}
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm -C client test -- useSearch && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useSearch.ts client/src/hooks/useSearch.test.tsx
git commit -m "Add useSearch query hook"
```

---

### Task 3: `SearchOverlay` component

**Files:**
- Create: `client/src/components/search/SearchOverlay.tsx`
- Create: `client/src/components/search/SearchOverlay.test.tsx`

**Interfaces:**
- Consumes: `useSearch` (Task 2); `Input`; `useNavigate`.
- Produces: `SearchOverlay({ open, onClose })` — `open: boolean`,
  `onClose: () => void`. When open, renders a modal (backdrop + centered panel)
  with a search input (debounced ~250ms) and a note-results list; clicking a
  result navigates to `/vaults/${containerId}/notes/${path}` and calls `onClose`;
  Esc or a backdrop click calls `onClose`. Renders `null` when closed. Task 4
  (`GlobalSearch`) consumes it.

- [ ] **Step 1: Write the failing tests**

`client/src/components/search/SearchOverlay.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { SearchOverlay } from './SearchOverlay'

function renderOverlay(open = true) {
  const onClose = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [{ path: '/', element: <SearchOverlay open={open} onClose={onClose} /> }],
    { initialEntries: ['/'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { onClose, router }
}

describe('SearchOverlay', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders nothing when closed', () => {
    renderOverlay(false)
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })

  it('debounce-searches and shows note results; clicking one navigates + closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, [
          { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'people/jane', snippet: 'about jane', score: 1 },
          { resourceType: 'code', id: 'c1', containerId: 'r1', path: 'src/x.ts', snippet: 'code', score: 0.5 },
        ]),
      ),
    )
    const { onClose, router } = renderOverlay(true)

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'jane' } })
    await vi.advanceTimersByTimeAsync(300)

    // note result shown, code result filtered out
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    expect(screen.queryByText('src/x.ts')).toBeNull()

    fireEvent.click(screen.getByText('people/jane'))
    expect(router.state.location.pathname).toBe('/vaults/v1/notes/people/jane')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const { onClose } = renderOverlay(true)
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `pnpm -C client test -- SearchOverlay`
Expected: FAIL — `./SearchOverlay` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/components/search/SearchOverlay.tsx`:
```tsx
import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { Input } from '../ui/input'
import { useSearch } from '../../hooks/useSearch'

interface SearchOverlayProps {
  open: boolean
  onClose: () => void
}

export function SearchOverlay({ open, onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 250)
    return () => clearTimeout(id)
  }, [query])

  const results = useSearch(debounced)
  const notes = (results.data ?? []).filter((r) => r.resourceType === 'note')

  if (!open) return null

  function go(containerId: string, path: string) {
    onClose()
    navigate(`/vaults/${containerId}/notes/${path}`)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-background shadow-lg">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search notes…"
          className="h-11 rounded-none border-0 border-b border-border text-base focus-visible:ring-0"
        />
        <ul className="max-h-[50vh] overflow-auto">
          {notes.map((r) => (
            <li key={`${r.resourceType}:${r.id}`}>
              <button
                type="button"
                onClick={() => go(r.containerId, r.path)}
                className="block w-full px-4 py-2 text-left hover:bg-muted"
              >
                <div className="text-sm">{r.path}</div>
                <div className="truncate text-xs text-muted-foreground">{r.snippet}</div>
              </button>
            </li>
          ))}
          {debounced.trim() && !results.isPending && notes.length === 0 && (
            <li className="px-4 py-3 text-sm text-muted-foreground">No notes found.</li>
          )}
        </ul>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm -C client test -- SearchOverlay && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/search/SearchOverlay.tsx client/src/components/search/SearchOverlay.test.tsx
git commit -m "Add SearchOverlay component"
```

---

### Task 4: `GlobalSearch` — ⌘K binding, mounted in `RequireAuth`

**Files:**
- Create: `client/src/components/search/GlobalSearch.tsx`
- Create: `client/src/components/search/GlobalSearch.test.tsx`
- Modify: `client/src/components/RequireAuth.tsx`

**Interfaces:**
- Consumes: `SearchOverlay` (Task 3).
- Produces: `GlobalSearch()` — owns `open` state and a `keydown` listener that
  opens the overlay on ⌘K/Ctrl+K (preventing the browser default), renders
  `<SearchOverlay open onClose />`. `RequireAuth` renders it alongside `<Outlet />`.

- [ ] **Step 1: Write the failing tests**

`client/src/components/search/GlobalSearch.test.tsx`:
```tsx
import { describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { GlobalSearch } from './GlobalSearch'

function renderGlobal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/', element: <GlobalSearch /> }], { initialEntries: ['/'] })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('GlobalSearch', () => {
  it('opens the overlay on Cmd/Ctrl+K and closes on Escape', () => {
    renderGlobal()
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument()

    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: 'Escape' })
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `pnpm -C client test -- GlobalSearch`
Expected: FAIL — `./GlobalSearch` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/components/search/GlobalSearch.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { SearchOverlay } from './SearchOverlay'

export function GlobalSearch() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return <SearchOverlay open={open} onClose={() => setOpen(false)} />
}
```

Modify `client/src/components/RequireAuth.tsx` — render `GlobalSearch` alongside
the outlet:
```tsx
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
```

- [ ] **Step 4: Run the full suite + typecheck + lint + build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm lint && pnpm -C client build`
Expected: all pass/exit 0. (Confirm the existing `RequireAuth.test.tsx` still
passes — `GlobalSearch` renders `null` until ⌘K, so it doesn't change the
guard's behavior; the tree now needs a `QueryClientProvider` around any test
that mounts `RequireAuth` — check `RequireAuth.test.tsx` and, if it renders
`RequireAuth` without one, wrap it, since `GlobalSearch`→`SearchOverlay`→
`useSearch` calls `useQuery`. If instead `SearchOverlay` returning `null` while
closed means `useSearch` never runs, no wrapper is needed — verify which and
adjust minimally.)

- [ ] **Step 5: Commit**

```bash
git add client/src/components/search/GlobalSearch.tsx client/src/components/search/GlobalSearch.test.tsx client/src/components/RequireAuth.tsx
git commit -m "Mount a global Cmd+K search overlay in RequireAuth"
```

---

### Task 5: Final verification + docs

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
pnpm -C client test
pnpm -C client build
```
Expected: all exit 0.

- [ ] **Step 2: Update README.md**

Add a line: ⌘K (Ctrl+K) opens a search overlay across all your vaults; matching
notes are listed and clicking one jumps to it. Update the slice-status lines:
Slice 3 (Search) in progress — ⌘K overlay (3a) done, keyboard navigation next.

- [ ] **Step 3: Update STATE.md**

Record Slice 3a complete; name the next increment (3b: keyboard navigation in the
overlay — arrow up/down to move the selection, Enter to open it). Keep the file
at or under 40 lines.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/agents/STATE.md
git commit -m "Update README and STATE.md for Slice 3a"
```

---

## Self-Review

**Spec coverage:** Hosted-UI structure §3 "Search (overlay, not a page)" and the
search-design spec's hybrid keyword+semantic, permission-filtered search — a ⌘K
overlay hitting `GET /search` (which is permission-filtered in-query, server-side)
and listing note matches is covered. Keyboard navigation is the next increment
(3b), documented. Code results are filtered out (no code viewer yet) — a
documented boundary.

**Placeholder scan:** no TBD/TODO; every code step is complete. Task 4 Step 4's
`RequireAuth.test.tsx` note is a real, specified adjustment (add a
`QueryClientProvider` only if the test mounts `RequireAuth` and the closed
overlay still runs `useSearch`), not a vague placeholder.

**Type consistency:** `SearchResult` (Task 1) is imported by `useSearch` (Task 2)
and used by `SearchOverlay` (Task 3), never redefined. `useSearch(query)` (Task 2)
is called by `SearchOverlay` with the debounced query. `SearchOverlay({ open,
onClose })` (Task 3) is rendered by `GlobalSearch` (Task 4) with exactly those
props. Navigation target `/vaults/${containerId}/notes/${path}` matches the note
route used across the app; `containerId` is the vaultId for note results.
