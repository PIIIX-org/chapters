# UI Slice 2b-5: Note Rename + Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an edit-capable user rename or delete a note from the file-tree
sidebar — with inline rename (new name, same type) and a two-step delete
confirm — refreshing the tree and navigating appropriately when the affected
note is the one currently open.

**Architecture:** `renameNote`/`deleteNote` API fns + `useRenameNote`/
`useDeleteNote` mutation hooks (both invalidate the vault tree). A self-contained
`NoteActions` component per note (owns its rename/delete UI, mutations, and
navigation) rendered inside `FileTree` behind a new `canEdit` prop that
`VaultLayout` supplies.

**Tech Stack:** React, TanStack Query mutations, React Router (`useNavigate`,
`useParams`), existing `Input`/`Button`/`FormError` primitives, Vitest +
happy-dom.

## Global Constraints

- **Backend contracts (read verbatim from `server/src/notes/routes.ts` +
  `store.ts`):**
  - **Rename:** `POST /vaults/:id/notes-rename` body `{ from, to }`, `edit`-gated
    (404 below). `from` = the note's current path (`type/name`); `to` = a new
    **name** (slug, max 200) — the type is unchanged, new path = `type/to`.
    Returns the renamed note (full `NoteRow`: `id`, `path` = new path, `type`,
    `name`). Collision → **409** `{ error }`; invalid slug → **400**; not
    found → **404**.
  - **Delete:** `DELETE /vaults/:id/notes/*` (path in the URL), `edit`-gated.
    Soft-delete (trash). Returns `{ status: 'trashed', id }`. Not found → 404.
- **Slug:** the new name must match `^[a-z0-9][a-z0-9-]*$` — validate client-side
  before the rename call; server is authority.
- **Tree refresh:** both mutations invalidate `['vault-tree', vaultId]` (matches
  `useVaultTree`) so the sidebar updates.
- **Navigation:** if the renamed/deleted note is the one currently open
  (`useParams()['*'] === note.path`): on rename, navigate to the returned new
  path; on delete, navigate to the vault root (`/vaults/:vaultId`). If it's not
  the open note, do not navigate.
- **Permission:** rename/delete affordances appear only when `canEdit` — reuse
  the `canEdit` helper; `VaultLayout` passes a `canEdit` boolean to `FileTree`.
- pnpm; strict TS + `verbatimModuleSyntax`; Vitest explicit imports; happy-dom;
  existing `Input`/`Button`/`FormError` primitives + design tokens only (no new
  deps, no invented styles). Root `pnpm lint` must be clean before each commit.
  **This repo's ESLint has no unused-var ignore pattern — no `_`-prefixed unused
  vars.** `Button` variants: `default|outline|secondary|ghost|destructive|link`;
  sizes: `default|xs|sm|lg|icon|…` (use `ghost`/`destructive` + `xs`).
- **Out of scope** (defer): changing a note's `type` (rename is name-only);
  moving notes between types; trash/restore UI; multi-select; live-preview;
  wikilinks.
- Anti-slop tooling (`impeccable`) fires on writes/edits — fix findings before
  each commit.

---

### Task 1: `renameNote` + `deleteNote` API functions

**Files:**
- Modify: `client/src/api/notes.ts`
- Modify: `client/src/api/notes.test.ts`

**Interfaces:**
- Produces: `interface RenameNoteInput { from: string; to: string }`,
  `interface RenameNoteResult { id: string; path: string; type: string; name: string }`,
  `function renameNote(vaultId: string, input: RenameNoteInput): Promise<RenameNoteResult>`;
  `interface DeleteNoteResult { status: string; id: string }`,
  `function deleteNote(vaultId: string, path: string): Promise<DeleteNoteResult>`.
  Task 2 consumes these.

- [ ] **Step 1: Write the failing tests**

Add to `client/src/api/notes.test.ts` (extend the import to include `renameNote, deleteNote`):
```ts
  it('renameNote POSTs /api/vaults/:id/notes-rename with from and to', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, { id: 'n1', path: 'people/jane-doe', type: 'people', name: 'jane-doe', frontmatter: {}, body: '', updatedAt: '2026-01-02' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await renameNote('v1', { from: 'people/jane', to: 'jane-doe' })

    expect(result.path).toBe('people/jane-doe')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/notes-rename',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ from: 'people/jane', to: 'jane-doe' }) }),
    )
  })

  it('deleteNote DELETEs /api/vaults/:id/notes/:path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'trashed', id: 'n1' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await deleteNote('v1', 'people/jane')

    expect(result.status).toBe('trashed')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/notes/people/jane',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
```

- [ ] **Step 2: Run, confirm fail**

Run: `pnpm -C client test -- notes`
Expected: FAIL — `renameNote`/`deleteNote` not exported yet.

- [ ] **Step 3: Implement**

Add to `client/src/api/notes.ts` (after `createNote`):
```ts
export interface RenameNoteInput {
  from: string
  to: string
}

export interface RenameNoteResult {
  id: string
  path: string
  type: string
  name: string
}

export function renameNote(vaultId: string, input: RenameNoteInput): Promise<RenameNoteResult> {
  return apiFetch(`/vaults/${vaultId}/notes-rename`, { method: 'POST', body: JSON.stringify(input) })
}

export interface DeleteNoteResult {
  status: string
  id: string
}

export function deleteNote(vaultId: string, path: string): Promise<DeleteNoteResult> {
  return apiFetch(`/vaults/${vaultId}/notes/${path}`, { method: 'DELETE' })
}
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm -C client test -- notes && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/notes.ts client/src/api/notes.test.ts
git commit -m "Add renameNote and deleteNote API functions"
```

---

### Task 2: `useRenameNote` + `useDeleteNote` hooks

**Files:**
- Create: `client/src/hooks/useRenameNote.ts`
- Create: `client/src/hooks/useDeleteNote.ts`
- Create: `client/src/hooks/useRenameNote.test.tsx`
- Create: `client/src/hooks/useDeleteNote.test.tsx`

**Interfaces:**
- Consumes: `renameNote`/`deleteNote` + their types (Task 1).
- Produces: `useRenameNote(vaultId)` → `UseMutationResult<RenameNoteResult, ApiError, RenameNoteInput>`;
  `useDeleteNote(vaultId)` → `UseMutationResult<DeleteNoteResult, ApiError, string>` (the arg is the note path).
  Both invalidate `['vault-tree', vaultId]` on success. Task 3 consumes them.

- [ ] **Step 1: Write the failing tests**

`client/src/hooks/useRenameNote.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useRenameNote } from './useRenameNote'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useRenameNote', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renames a note and resolves with the new path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, { id: 'n1', path: 'people/jane-doe', type: 'people', name: 'jane-doe', frontmatter: {}, body: '', updatedAt: '2026-01-02' }),
      ),
    )

    const { result } = renderHook(() => useRenameNote('v1'), { wrapper })
    result.current.mutate({ from: 'people/jane', to: 'jane-doe' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.path).toBe('people/jane-doe')
  })
})
```

`client/src/hooks/useDeleteNote.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useDeleteNote } from './useDeleteNote'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useDeleteNote', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deletes a note and resolves trashed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'trashed', id: 'n1' })))

    const { result } = renderHook(() => useDeleteNote('v1'), { wrapper })
    result.current.mutate('people/jane')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.status).toBe('trashed')
  })
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `pnpm -C client test -- useRenameNote useDeleteNote`
Expected: FAIL — the hooks don't exist yet.

- [ ] **Step 3: Implement**

`client/src/hooks/useRenameNote.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { renameNote } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { RenameNoteInput, RenameNoteResult } from '../api/notes.js'

export function useRenameNote(vaultId: string) {
  const queryClient = useQueryClient()
  return useMutation<RenameNoteResult, ApiError, RenameNoteInput>({
    mutationFn: (input) => renameNote(vaultId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vault-tree', vaultId] })
    },
  })
}
```

`client/src/hooks/useDeleteNote.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteNote } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { DeleteNoteResult } from '../api/notes.js'

export function useDeleteNote(vaultId: string) {
  const queryClient = useQueryClient()
  return useMutation<DeleteNoteResult, ApiError, string>({
    mutationFn: (path) => deleteNote(vaultId, path),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vault-tree', vaultId] })
    },
  })
}
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm -C client test -- useRenameNote useDeleteNote && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useRenameNote.ts client/src/hooks/useDeleteNote.ts client/src/hooks/useRenameNote.test.tsx client/src/hooks/useDeleteNote.test.tsx
git commit -m "Add useRenameNote and useDeleteNote mutation hooks"
```

---

### Task 3: `NoteActions` component (rename + delete)

**Files:**
- Create: `client/src/components/vault/NoteActions.tsx`
- Create: `client/src/components/vault/NoteActions.test.tsx`

**Interfaces:**
- Consumes: `useRenameNote`/`useDeleteNote` (Task 2); `NoteSummary` type from
  `../../api/notes`; `Input`/`Button`/`FormError`; `useNavigate`/`useParams`.
- Produces: `NoteActions({ vaultId, note })` — `note: NoteSummary`. Renders
  Rename/Delete controls; inline rename (slug-validated) and two-step delete
  confirm; on success invalidates the tree (via the hooks) and navigates only if
  `note` is the currently-open note. Task 4 (`FileTree`) consumes it.

- [ ] **Step 1: Write the failing tests**

`client/src/components/vault/NoteActions.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import type { NoteSummary } from '../../api/notes'
import { NoteActions } from './NoteActions'

const NOTE: NoteSummary = { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' }

function renderActions(currentPath = '/vaults/v1/notes/other/thing') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [{ path: '/vaults/:vaultId/notes/*', element: <NoteActions vaultId="v1" note={NOTE} /> }],
    { initialEntries: [currentPath] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function calls(fetchMock: ReturnType<typeof vi.fn>, method: string) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method)
}

describe('NoteActions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renames a note via the inline form (POST notes-rename)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, { id: 'n1', path: 'people/jane-doe', type: 'people', name: 'jane-doe', frontmatter: {}, body: '', updatedAt: '2026-01-02' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderActions()

    fireEvent.click(screen.getByRole('button', { name: /rename jane/i }))
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'jane-doe' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/vaults/v1/notes-rename',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ from: 'people/jane', to: 'jane-doe' }) }),
      ),
    )
  })

  it('rejects an invalid rename slug before calling the server', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderActions()

    fireEvent.click(screen.getByRole('button', { name: /rename jane/i }))
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Jane Doe' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(screen.getByText(/name must be/i)).toBeInTheDocument()
    expect(calls(fetchMock, 'POST')).toHaveLength(0)
  })

  it('deletes a note after confirming (DELETE)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'trashed', id: 'n1' }))
    vi.stubGlobal('fetch', fetchMock)
    renderActions()

    fireEvent.click(screen.getByRole('button', { name: /delete jane/i }))
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/vaults/v1/notes/people/jane', expect.objectContaining({ method: 'DELETE' })),
    )
  })
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `pnpm -C client test -- NoteActions`
Expected: FAIL — `./NoteActions` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/components/vault/NoteActions.tsx`:
```tsx
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { FormError } from '../FormError'
import { useRenameNote } from '../../hooks/useRenameNote'
import { useDeleteNote } from '../../hooks/useDeleteNote'
import type { NoteSummary } from '../../api/notes'

const SLUG = /^[a-z0-9][a-z0-9-]*$/

interface NoteActionsProps {
  vaultId: string
  note: NoteSummary
}

export function NoteActions({ vaultId, note }: NoteActionsProps) {
  const [mode, setMode] = useState<'idle' | 'renaming' | 'confirmDelete'>('idle')
  const [name, setName] = useState(note.name)
  const [error, setError] = useState<string | null>(null)
  const renameNote = useRenameNote(vaultId)
  const deleteNote = useDeleteNote(vaultId)
  const navigate = useNavigate()
  const isOpen = useParams()['*'] === note.path

  function submitRename(e: FormEvent) {
    e.preventDefault()
    if (!SLUG.test(name)) {
      setError('Name must be lowercase letters, numbers, and hyphens.')
      return
    }
    setError(null)
    renameNote.mutate(
      { from: note.path, to: name },
      {
        onSuccess: (renamed) => {
          setMode('idle')
          if (isOpen) navigate(`/vaults/${vaultId}/notes/${renamed.path}`)
        },
        onError: (err) => setError(err.message || 'Could not rename the note.'),
      },
    )
  }

  function confirmDelete() {
    setError(null)
    deleteNote.mutate(note.path, {
      onSuccess: () => {
        setMode('idle')
        if (isOpen) navigate(`/vaults/${vaultId}`)
      },
      onError: (err) => setError(err.message || 'Could not delete the note.'),
    })
  }

  if (mode === 'renaming') {
    return (
      <form onSubmit={submitRename} className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="New name" className="h-6" />
          <Button type="submit" size="xs" disabled={renameNote.isPending}>Save</Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              setMode('idle')
              setName(note.name)
              setError(null)
            }}
          >
            Cancel
          </Button>
        </div>
        <FormError message={error} />
      </form>
    )
  }

  if (mode === 'confirmDelete') {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Delete?</span>
          <Button type="button" size="xs" variant="destructive" onClick={confirmDelete} disabled={deleteNote.isPending}>
            Delete
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => { setMode('idle'); setError(null) }}>
            Cancel
          </Button>
        </div>
        <FormError message={error} />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setMode('renaming')}
        aria-label={`Rename ${note.name}`}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        Rename
      </button>
      <button
        type="button"
        onClick={() => setMode('confirmDelete')}
        aria-label={`Delete ${note.name}`}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        Delete
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm -C client test -- NoteActions && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/vault/NoteActions.tsx client/src/components/vault/NoteActions.test.tsx
git commit -m "Add NoteActions (inline rename + confirm delete)"
```

---

### Task 4: Wire `NoteActions` into `FileTree` (canEdit)

**Files:**
- Modify: `client/src/components/vault/FileTree.tsx`
- Modify: `client/src/components/vault/FileTree.test.tsx`
- Modify: `client/src/pages/vault/VaultLayout.tsx`

**Interfaces:**
- Consumes: `NoteActions` (Task 3); `canEdit` (already used by `VaultLayout`).
- Produces: `FileTree` gains a `canEdit: boolean` prop; when true, renders
  `<NoteActions>` for each note. `VaultLayout` passes `canEdit(vault?.access)`.

- [ ] **Step 1: Update FileTree tests**

Read the current `client/src/components/vault/FileTree.test.tsx`. Its existing
render calls now need the new required `canEdit` prop — update them to pass
`canEdit={false}` (preserving their current assertions: links render, group by
type). Then add one test: with `canEdit={true}` (and the component wrapped in a
`createMemoryRouter` at some `/vaults/:vaultId/notes/*` entry, since `NoteActions`
uses router hooks), a note's "Rename <name>" control is present; with
`canEdit={false}` it is absent (`queryByRole(... /rename/i)` is null). Mirror the
existing file's router/render setup; if it currently renders `FileTree` bare
(no router), wrap the new canEdit-true case in `createMemoryRouter` so
`NoteActions`' `useParams`/`useNavigate` resolve.

- [ ] **Step 2: Run, confirm the new/updated tests fail**

Run: `pnpm -C client test -- FileTree`
Expected: FAIL — `FileTree` doesn't accept/act on `canEdit` yet (and the
canEdit-true test finds no Rename control).

- [ ] **Step 3: Implement**

Replace `client/src/components/vault/FileTree.tsx` with:
```tsx
import { Link } from 'react-router'
import { NoteActions } from './NoteActions.js'
import type { VaultTree } from '../../api/notes.js'

interface FileTreeProps {
  vaultId: string
  tree: VaultTree
  canEdit: boolean
}

export function FileTree({ vaultId, tree, canEdit }: FileTreeProps) {
  return (
    <nav>
      {Object.entries(tree).map(([type, notes]) => (
        <div key={type} className="mb-4">
          <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">{type}</div>
          {notes.map((note) => (
            <div key={note.id} className="flex items-center justify-between gap-1">
              <Link
                to={`/vaults/${vaultId}/notes/${note.path}`}
                className="min-w-0 flex-1 truncate rounded px-2 py-1 text-sm hover:bg-muted"
              >
                {note.name}
              </Link>
              {canEdit && <NoteActions vaultId={vaultId} note={note} />}
            </div>
          ))}
        </div>
      ))}
    </nav>
  )
}
```

In `client/src/pages/vault/VaultLayout.tsx`, the `<FileTree>` render currently is
`{tree.data && <FileTree vaultId={vaultId!} tree={tree.data} />}`. Add the prop:
```tsx
        {tree.data && <FileTree vaultId={vaultId!} tree={tree.data} canEdit={canEdit(vault?.access)} />}
```
(`canEdit` is already imported in `VaultLayout` from Slice 2b-4; if not, add
`import { canEdit } from '../../api/vaults.js'`.)

- [ ] **Step 4: Run tests + typecheck + lint + build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm lint && pnpm -C client build`
Expected: all pass/exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/vault/FileTree.tsx client/src/components/vault/FileTree.test.tsx client/src/pages/vault/VaultLayout.tsx
git commit -m "Render NoteActions in FileTree behind canEdit"
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

Update the editor status copy so note **rename and delete** are listed as done
(edit-only, from the sidebar; rename keeps the type, delete trashes the note),
leaving live-preview rendering and wikilinks as next. Update the two
slice-status lines to include Slice 2b-5.

- [ ] **Step 3: Update STATE.md**

Record Slice 2b-5 complete and name the next increment (live-preview markdown
rendering inside CodeMirror). Keep the file at or under 40 lines.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/agents/STATE.md
git commit -m "Update README and STATE.md for Slice 2b-5"
```

---

## Self-Review

**Spec coverage:** Editor spec §Note-lifecycle "Rename/delete: standard
file-tree operations (rename updates the note's path/name; delete removes it),
gated by `edit`" — covered: rename via the inline form (name-only, server
recomputes the path), delete via a two-step confirm (soft-delete/trash), both
behind `canEdit`, with navigation when the open note is affected. Changing a
note's *type* (a move) is out of scope, consistent with the backend rename
contract (`to` is a name within the same type).

**Placeholder scan:** no TBD/TODO. Tasks 1–3 have complete verbatim code. Tasks
4's FileTree test step describes assertions rather than a verbatim block because
it must match the existing `FileTree.test.tsx` harness (which the implementer
reads first) — the assertions are fully specified.

**Type consistency:** `RenameNoteInput`/`RenameNoteResult`/`DeleteNoteResult`
(Task 1) are consumed by name in Tasks 2–3, never redefined. `useRenameNote`/
`useDeleteNote` (Task 2) are called exactly as defined by `NoteActions` (Task 3);
`useDeleteNote`'s `mutate` takes the note path (a string), matching `deleteNote`.
`NoteActions({ vaultId, note })` (Task 3) matches how `FileTree` renders it
(Task 4). The invalidated `['vault-tree', vaultId]` matches `useVaultTree`. The
`FileTree` `canEdit` prop is supplied by `VaultLayout`'s `canEdit(vault?.access)`.
