# UI Slice 2b-4: Note Creation (Type-First) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an edit-capable user create a new note from the vault sidebar via
a type-first flow (pick/enter a `type`, then a `name`), which POSTs to the
backend and navigates to the new note.

**Architecture:** A small self-contained `NewNoteForm` (type `datalist` +
name input + client slug-check + server-error display, backed by a
`useCreateNote` mutation that invalidates the vault tree) rendered in
`VaultLayout`'s sidebar behind a "New note" toggle — shown only when the user
`canEdit` the vault. On success, `VaultLayout` navigates to the created note.

**Tech Stack:** React (`useState`), TanStack Query mutation, React Router
`useNavigate`, existing `Input`/`Label`/`Button` primitives, Vitest + happy-dom.

## Global Constraints

- **Backend contract (read verbatim from `server/src/notes/routes.ts` +
  `store.ts`):** `POST /vaults/:id/notes` with body `{ type, name,
  frontmatter?, body? }`, gated to `edit` (404 below it). Returns the created
  note (full `NoteRow`: has `id`, `path` = `type/name`, `type`, `name`, …).
  `createNote` auto-adds a `timestamp`, forces `type`, defaults `body` to `''`.
  A path collision → **409** (`OkfValidationError "a note already exists at …"`);
  an invalid slug → **400**. The client surfaces these errors from the thrown
  `ApiError.message`.
- **Slugs:** `type` and `name` must match `^[a-z0-9][a-z0-9-]*$` (lowercase
  alphanumeric + hyphens, not starting with a hyphen). Validate client-side for
  a fast message; the server is the authority.
- **Permission:** the create affordance appears only when `canEdit(vault?.access)`
  (`edit`/`owner`) — reuse the `canEdit` helper from `client/src/api/vaults.ts`.
- **Tree refresh:** after a successful create, invalidate the vault-tree query
  key `['vault-tree', vaultId]` (from `useVaultTree`) so the new note appears.
- pnpm only; strict TS + `verbatimModuleSyntax` (type-only imports use
  `import type`); Vitest tests import `describe`/`it`/`expect` explicitly (no
  globals); happy-dom test env. Root `pnpm lint` must be clean before each
  commit. **This repo's ESLint has no unused-var ignore pattern — do not write
  `_`-prefixed unused variables** (they fail lint).
- Use existing UI primitives + design tokens (`text-destructive`,
  `text-muted-foreground`, etc.) — no new deps, no invented styles.
- **Out of scope** (defer): note rename and delete (2b-5); editing/removing an
  existing note's type; a full note-body template on create (body starts empty);
  live-preview; wikilinks.
- Anti-slop tooling (`impeccable`) fires on writes/edits — fix findings before
  each commit.

---

### Task 1: `createNote` API function

**Files:**
- Modify: `client/src/api/notes.ts` (add to the existing file)
- Modify: `client/src/api/notes.test.ts` (add to the existing file)

**Interfaces:**
- Consumes: `apiFetch` from `../lib/api.js`.
- Produces: `interface CreateNoteInput { type: string; name: string }`,
  `interface CreateNoteResult { id: string; path: string; type: string; name: string }`,
  `function createNote(vaultId: string, input: CreateNoteInput): Promise<CreateNoteResult>`.
  Task 2 (`useCreateNote`) consumes these.

- [ ] **Step 1: Write the failing test**

Add to `client/src/api/notes.test.ts` (update the import line to include
`createNote`, add inside the existing describe block):
```ts
  it('createNote POSTs /api/vaults/:id/notes with type and name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(201, { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, body: '', updatedAt: '2026-01-01' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await createNote('v1', { type: 'people', name: 'jane' })

    expect(result.path).toBe('people/jane')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/notes',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ type: 'people', name: 'jane' }) }),
    )
  })
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test -- notes`
Expected: FAIL — `createNote` is not exported yet.

- [ ] **Step 3: Implement**

Add to `client/src/api/notes.ts` (after the existing `updateNote`):
```ts
export interface CreateNoteInput {
  type: string
  name: string
}

export interface CreateNoteResult {
  id: string
  path: string
  type: string
  name: string
}

export function createNote(vaultId: string, input: CreateNoteInput): Promise<CreateNoteResult> {
  return apiFetch(`/vaults/${vaultId}/notes`, { method: 'POST', body: JSON.stringify(input) })
}
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm -C client test -- notes && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/notes.ts client/src/api/notes.test.ts
git commit -m "Add createNote API function"
```

---

### Task 2: `useCreateNote` mutation hook

**Files:**
- Create: `client/src/hooks/useCreateNote.ts`
- Create: `client/src/hooks/useCreateNote.test.tsx`

**Interfaces:**
- Consumes: `createNote`, `CreateNoteInput`, `CreateNoteResult` (Task 1).
- Produces: `useCreateNote(vaultId: string)` — a `UseMutationResult<CreateNoteResult, ApiError, CreateNoteInput>` that invalidates `['vault-tree', vaultId]` on success. Task 3 (`NewNoteForm`) consumes it.

- [ ] **Step 1: Write the failing test**

`client/src/hooks/useCreateNote.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useCreateNote } from './useCreateNote'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useCreateNote', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates a note and resolves with the result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(201, { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, body: '', updatedAt: '2026-01-01' }),
      ),
    )

    const { result } = renderHook(() => useCreateNote('v1'), { wrapper })
    result.current.mutate({ type: 'people', name: 'jane' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.path).toBe('people/jane')
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test -- useCreateNote`
Expected: FAIL — `./useCreateNote` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/hooks/useCreateNote.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createNote } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { CreateNoteInput, CreateNoteResult } from '../api/notes.js'

export function useCreateNote(vaultId: string) {
  const queryClient = useQueryClient()
  return useMutation<CreateNoteResult, ApiError, CreateNoteInput>({
    mutationFn: (input) => createNote(vaultId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vault-tree', vaultId] })
    },
  })
}
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm -C client test -- useCreateNote && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useCreateNote.ts client/src/hooks/useCreateNote.test.tsx
git commit -m "Add useCreateNote mutation hook"
```

---

### Task 3: `NewNoteForm` component

**Files:**
- Create: `client/src/components/vault/NewNoteForm.tsx`
- Create: `client/src/components/vault/NewNoteForm.test.tsx`

**Interfaces:**
- Consumes: `useCreateNote` (Task 2); `Input`/`Label`/`Button` primitives;
  `CreateNoteResult` type (Task 1).
- Produces: `NewNoteForm({ vaultId, existingTypes, onCreated })` —
  `existingTypes: string[]` (populates a `type` datalist), `onCreated: (note: CreateNoteResult) => void`.
  Client-slug-validates `type`/`name`, POSTs via `useCreateNote`, calls
  `onCreated` on success, and shows the server error message on failure. Task 4
  (`VaultLayout`) consumes it.

- [ ] **Step 1: Write the failing tests**

`client/src/components/vault/NewNoteForm.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../../lib/api'
import { NewNoteForm } from './NewNoteForm'

function renderForm(onCreated = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <NewNoteForm vaultId="v1" existingTypes={['people']} onCreated={onCreated} />
    </QueryClientProvider>,
  )
}

describe('NewNoteForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects an invalid slug before calling the server', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderForm()

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'People!' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'jane' } })
    fireEvent.click(screen.getByRole('button', { name: /create note/i }))

    expect(screen.getByText(/type must be/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates a note and calls onCreated with the result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(201, { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, body: '', updatedAt: '2026-01-01' }),
      ),
    )
    const onCreated = vi.fn()
    renderForm(onCreated)

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'people' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'jane' } })
    fireEvent.click(screen.getByRole('button', { name: /create note/i }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ path: 'people/jane' })))
  })

  it('shows the server error message on a collision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(409, { error: 'a note already exists at people/jane' })),
    )
    renderForm()

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'people' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'jane' } })
    fireEvent.click(screen.getByRole('button', { name: /create note/i }))

    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeInTheDocument())
  })
})
```

Note: this assumes `apiFetch` throws an `ApiError` whose `.message` is the
server's `error` field for non-2xx responses (the established behavior across
this project's API layer). If the error text doesn't surface, read
`client/src/lib/api.ts` to confirm the `ApiError` shape and adjust the
displayed message source — do not change the test's intent.

- [ ] **Step 2: Run, confirm fail**

Run: `pnpm -C client test -- NewNoteForm`
Expected: FAIL — `./NewNoteForm` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/components/vault/NewNoteForm.tsx`:
```tsx
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { useCreateNote } from '../../hooks/useCreateNote'
import type { CreateNoteResult } from '../../api/notes'

const SLUG = /^[a-z0-9][a-z0-9-]*$/

interface NewNoteFormProps {
  vaultId: string
  existingTypes: string[]
  onCreated: (note: CreateNoteResult) => void
}

export function NewNoteForm({ vaultId, existingTypes, onCreated }: NewNoteFormProps) {
  const [type, setType] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const createNote = useCreateNote(vaultId)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!SLUG.test(type)) {
      setError('Type must be lowercase letters, numbers, and hyphens.')
      return
    }
    if (!SLUG.test(name)) {
      setError('Name must be lowercase letters, numbers, and hyphens.')
      return
    }
    setError(null)
    createNote.mutate(
      { type, name },
      {
        onSuccess: (note) => onCreated(note),
        onError: (err) => setError(err.message || 'Could not create the note.'),
      },
    )
  }

  return (
    <form onSubmit={handleSubmit} className="mb-4 flex flex-col gap-2">
      <Label htmlFor="nn-type">Type</Label>
      <Input
        id="nn-type"
        list="nn-types"
        value={type}
        onChange={(e) => setType(e.target.value)}
        placeholder="e.g. people"
      />
      <datalist id="nn-types">
        {existingTypes.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <Label htmlFor="nn-name">Name</Label>
      <Input
        id="nn-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. jane-doe"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" disabled={createNote.isPending}>
        {createNote.isPending ? 'Creating…' : 'Create note'}
      </Button>
    </form>
  )
}
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm -C client test -- NewNoteForm && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/vault/NewNoteForm.tsx client/src/components/vault/NewNoteForm.test.tsx
git commit -m "Add NewNoteForm (type-first note creation)"
```

---

### Task 4: Wire creation into `VaultLayout`

**Files:**
- Modify: `client/src/pages/vault/VaultLayout.tsx`
- Modify: `client/src/pages/vault/VaultLayout.test.tsx`

**Interfaces:**
- Consumes: `NewNoteForm` (Task 3); `canEdit` from `../../api/vaults`;
  `useNavigate` from `react-router`.
- Produces: no new exported interface — `VaultLayout` gains a `canEdit`-gated
  "New note" toggle that reveals `NewNoteForm` and navigates to the created note.

- [ ] **Step 1: Write the failing tests**

Read the current `client/src/pages/vault/VaultLayout.test.tsx` first to match
its setup (it mocks `useVaults`/`useVaultTree` or stubs fetch). Add two tests
following that file's existing pattern:
- an **edit-access** vault shows a "New note" control (`getByRole('button', { name: /new note/i })`);
- a **read-access** vault does NOT (`queryByRole('button', { name: /new note/i })` is null).

Because the exact mocking approach depends on the existing test, the
implementer writes these two tests against that file's established harness
rather than a prescribed verbatim block. Keep assertions to the affordance's
presence/absence by access level (the create+navigate flow itself is covered by
`NewNoteForm`'s own tests in Task 3).

- [ ] **Step 2: Run, confirm the new tests fail**

Run: `pnpm -C client test -- VaultLayout`
Expected: the two new tests FAIL — no "New note" control exists yet.

- [ ] **Step 3: Implement**

Modify `client/src/pages/vault/VaultLayout.tsx`. Add imports:
```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { canEdit } from '../../api/vaults.js'
import { NewNoteForm } from '../../components/vault/NewNoteForm.js'
```
Inside `VaultLayout`, after `const vault = vaults.data?.find(...)`, add:
```tsx
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const existingTypes = Object.keys(tree.data ?? {})
```
In the sidebar `<aside>`, between the "← Vaults" link and the `FileTree`, add
the gated affordance:
```tsx
        {canEdit(vault?.access) && (
          <div className="mb-4">
            {creating ? (
              <NewNoteForm
                vaultId={vaultId!}
                existingTypes={existingTypes}
                onCreated={(note) => {
                  setCreating(false)
                  navigate(`/vaults/${vaultId}/notes/${note.path}`)
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="w-full rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-muted"
              >
                + New note
              </button>
            )}
          </div>
        )}
```
(Leave the `← Vaults` link, `FileTree`, and `<Outlet context={vault} />`
unchanged otherwise.)

- [ ] **Step 4: Run tests + typecheck + lint + build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm lint && pnpm -C client build`
Expected: all pass/exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/vault/VaultLayout.tsx client/src/pages/vault/VaultLayout.test.tsx
git commit -m "Add canEdit-gated New note creation to VaultLayout"
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

Update the editor status copy (the "Note create/rename/delete … arrive in later
UI sub-plans" sentence) to reflect that note **creation** now works
(type-first, from the vault sidebar, edit-only), with rename/delete still to
come. Update the two slice-status lines to list Slice 2b-4 (note creation) among
the done slices.

- [ ] **Step 3: Update STATE.md**

Record Slice 2b-4 (note creation) complete and name the next increment (2b-5:
note rename + delete). Keep the file at or under 40 lines.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/agents/STATE.md
git commit -m "Update README and STATE.md for Slice 2b-4"
```

---

## Self-Review

**Spec coverage:** Editor spec §Note-lifecycle "Create: type-first flow — user
picks a `type` (existing or new) before naming the note … path derived
automatically" is covered: the `type` datalist offers existing types and
accepts a new one, `name` is separate, and the server derives `type/name`.
"Guarantees every note has a valid `type` from creation" holds — the slug check
plus server validation. Rename/delete (same spec section) are explicitly the
next increment (2b-5), not silently dropped.

**Placeholder scan:** no TBD/TODO; Tasks 1–3 have complete verbatim code. Task 4
intentionally describes its two tests rather than prescribing a verbatim block,
because they must match the existing `VaultLayout.test.tsx` harness (which the
implementer reads first) — the assertions are fully specified (affordance shown
for edit, absent for read).

**Type consistency:** `CreateNoteInput`/`CreateNoteResult` (Task 1) are imported
by name in Tasks 2 and 3, never redefined. `useCreateNote(vaultId)` (Task 2) is
called exactly that way by `NewNoteForm` (Task 3). `NewNoteForm`'s props
(`vaultId`, `existingTypes`, `onCreated`) match how `VaultLayout` passes them
(Task 4). The invalidated key `['vault-tree', vaultId]` matches `useVaultTree`'s
own query key.
