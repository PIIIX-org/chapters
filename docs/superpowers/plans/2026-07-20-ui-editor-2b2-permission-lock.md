# UI Slice 2b-2: Permission-Aware Editor Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the note editor honor the user's effective vault permission —
a `read`-only user gets a genuinely non-editable rendered note (no caret, no
autosave), while `edit`/`owner` users keep the full editor from Slice 2b-1.

**Architecture:** The client already knows the user's per-vault access
(`Vault.access`, delivered on the vault list and reaching `NoteView` via
outlet context). Add a `readOnly` option to the `useCodeMirrorEditor` hook
that applies CodeMirror's own read-only facets, and derive `readOnly` in
`NoteView` from the access level. The server already enforces this (every
write route is gated to `edit` and 404s below it); this increment stops the
client from offering edits it knows will be rejected and silently dropped.

**Tech Stack:** CodeMirror 6 (`EditorState.readOnly`, `EditorView.editable`
facets — no new dependencies), React Router (`useOutletContext`), Vitest +
happy-dom.

## Global Constraints

- Access model (from `server/src/vaults/permissions.ts` and mirrored in
  `client/src/api/vaults.ts`): `type VaultAccess = 'read' | 'edit' | 'owner'`.
  Editing is allowed iff access is `edit` or `owner`. `owner` behaves
  identically to `edit` for editing (editor spec §Assumptions).
- The server is the real gate: `PUT`/`POST`/`DELETE` note routes all call
  `guard(req, reply, 'edit')` and reply **404** (not 403 — deliberately, so
  no-access is indistinguishable from no-vault) when access is below `edit`.
  This client-side lock is a UX layer on top of that, never the only guard.
- Editor spec `2026-07-09-editor-design.md` §"Permission-aware rendering":
  `read`-only → note opens rendered but non-editable, body locked, no autosave
  triggers. `edit`/`owner` → full editor.
- **Conservative default:** if access is unknown (`vault` undefined), treat
  the note as read-only. The server will reject a stray edit with a 404 that
  the client currently swallows silently — a too-cautious lock is strictly
  better than an editor that looks live but discards the user's work.
- pnpm only; strict TypeScript with `verbatimModuleSyntax` (type-only imports
  use `import type`); Vitest tests import `describe`/`it`/`expect` explicitly
  (no globals); test environment is happy-dom globally. CM6 mounts fine under
  happy-dom (confirmed in 2b-1 — no `Range` polyfill needed).
- **Out of scope** (explicitly deferred, do not build): the editable
  frontmatter property panel (the `<dl>` stays read-only display — that's
  increment 2b-3), note create/rename/delete affordances in the file tree
  (2b-4), surfacing save *errors* to edit-capable users (separate concern —
  note as deferred if relevant, don't build), live-preview markdown rendering,
  and wikilinks (2c).
- Anti-slop tooling (`impeccable`) fires on file writes/edits — fix findings
  before a task's commit step. `pnpm lint` (root) must be clean before commit
  (lesson from 2b-1: per-task gates must include lint, not just typecheck/build).

---

### Task 1: `readOnly` option in `useCodeMirrorEditor`

**Files:**
- Modify: `client/src/hooks/useCodeMirrorEditor.ts`
- Modify: `client/src/hooks/useCodeMirrorEditor.test.tsx`

**Interfaces:**
- Produces: `useCodeMirrorEditor({ doc, onChange, readOnly? })` — when
  `readOnly` is true the editor is genuinely non-editable (the `.cm-content`
  element has `contenteditable="false"`); when false/omitted it is editable
  (`contenteditable="true"`), unchanged from 2b-1. Task 2 (`NoteView`)
  consumes the new option.

- [ ] **Step 1: Write the failing tests**

Replace the `Harness` component and add two tests in
`client/src/hooks/useCodeMirrorEditor.test.tsx`. New `Harness`:
```tsx
function Harness({
  doc,
  onChange,
  readOnly,
}: {
  doc: string
  onChange: (doc: string) => void
  readOnly?: boolean
}) {
  const ref = useCodeMirrorEditor({ doc, onChange, readOnly })
  return <div ref={ref} data-testid="editor-container" />
}
```
Add these two tests inside the existing `describe('useCodeMirrorEditor', ...)`:
```tsx
  it('is editable by default (contenteditable true)', () => {
    const { getByTestId } = render(<Harness doc="# Hello" onChange={vi.fn()} />)

    const content = getByTestId('editor-container').querySelector('.cm-content')
    expect(content?.getAttribute('contenteditable')).toBe('true')
  })

  it('is non-editable when readOnly is set (contenteditable false)', () => {
    const { getByTestId } = render(<Harness doc="# Hello" onChange={vi.fn()} readOnly />)

    const content = getByTestId('editor-container').querySelector('.cm-content')
    expect(content?.getAttribute('contenteditable')).toBe('false')
  })
```

- [ ] **Step 2: Run the tests, confirm the new ones fail**

Run: `pnpm -C client test -- useCodeMirrorEditor`
Expected: the two new tests FAIL — `readOnly` isn't a recognized option yet, so
the editor is always editable (`contenteditable="true"`), and the read-only
assertion fails. (The `Harness` type change alone doesn't make it read-only.)

- [ ] **Step 3: Implement**

In `client/src/hooks/useCodeMirrorEditor.ts`, add `readOnly` to the options
interface and apply the read-only facets conditionally. Full file:
```ts
import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'

interface UseCodeMirrorEditorOptions {
  doc: string
  onChange: (doc: string) => void
  readOnly?: boolean
}

export function useCodeMirrorEditor({ doc, onChange, readOnly = false }: UseCodeMirrorEditorOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  // Keep the ref pointing at the latest onChange without re-running the
  // mount effect below. Assigned in an effect (not during render) so the
  // update is a committed side effect — the CM6 updateListener only reads
  // this ref at edit time, always after this effect has run.
  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    if (!containerRef.current) return

    const state = EditorState.create({
      doc,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
        EditorView.theme({
          '&': { fontFamily: 'var(--font-mono)', fontSize: '14px', height: '100%' },
          '.cm-content': { fontFamily: 'var(--font-mono)' },
          '.cm-scroller': { overflow: 'auto' },
        }),
        // A genuinely non-editable rendered view needs BOTH: readOnly blocks
        // edit transactions/commands, editable=false drops contentEditable so
        // there's no caret. (CM6's documented recipe for a true read-only view.)
        ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })

    return () => {
      view.destroy()
    }
    // Mount once per component instance — `doc` and `readOnly` are captured at
    // mount. Callers that need a different `readOnly` remount this component
    // (Task 2 keys on it), matching how `doc` is already handled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return containerRef
}
```

- [ ] **Step 4: Run the tests + typecheck + lint**

Run: `pnpm -C client test -- useCodeMirrorEditor && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0 (all four hook tests green, including the two
pre-existing ones — `readOnly` defaults to false so their behavior is
unchanged).

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useCodeMirrorEditor.ts client/src/hooks/useCodeMirrorEditor.test.tsx
git commit -m "Add readOnly option to useCodeMirrorEditor"
```

---

### Task 2: `canEdit` helper + permission-aware `NoteView`

**Files:**
- Modify: `client/src/api/vaults.ts` (add `canEdit` helper)
- Modify: `client/src/api/vaults.test.ts` (test the helper)
- Modify: `client/src/pages/vault/NoteView.tsx`
- Modify: `client/src/pages/vault/NoteView.test.tsx`

**Interfaces:**
- Consumes: `useCodeMirrorEditor`'s `readOnly` option (Task 1).
- Produces: `canEdit(access: VaultAccess | undefined): boolean` — true only for
  `edit`/`owner`. Reused by later increments (2b-3 property panel, 2b-4 file-tree
  affordances) for the same permission rule.

- [ ] **Step 1: Write the failing helper test**

Add to `client/src/api/vaults.test.ts` — update the import line to
`import { canEdit, getVaultAccess, listVaults } from './vaults'` and add,
inside the existing `describe('vaults api', ...)`:
```ts
  it('canEdit is true only for edit and owner access', () => {
    expect(canEdit('owner')).toBe(true)
    expect(canEdit('edit')).toBe(true)
    expect(canEdit('read')).toBe(false)
    expect(canEdit(undefined)).toBe(false)
  })
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test -- vaults`
Expected: FAIL — `canEdit` is not exported yet.

- [ ] **Step 3: Implement the helper**

Add to the end of `client/src/api/vaults.ts`:
```ts
/** Editing is allowed only for edit/owner access; unknown access is not. */
export function canEdit(access: VaultAccess | undefined): boolean {
  return access === 'edit' || access === 'owner'
}
```

- [ ] **Step 4: Run the helper test, confirm it passes**

Run: `pnpm -C client test -- vaults`
Expected: PASS.

- [ ] **Step 5: Write the failing NoteView tests**

Replace `client/src/pages/vault/NoteView.test.tsx` entirely with the version
below. It (a) provides the `vault` via a parent `Outlet context` route
(matching how `VaultLayout` really supplies it), (b) keeps the edit-access
debounce-save test, and (c) adds a read-only test asserting the editor is
non-editable and never PUTs:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import type { Vault } from '../../api/vaults'
import { NoteView } from './NoteView'

const EDIT_VAULT: Vault = { id: 'v1', name: 'V1', ownerId: 'u1', mergeable: false, access: 'edit' }
const READ_VAULT: Vault = { id: 'v1', name: 'V1', ownerId: 'u1', mergeable: false, access: 'read' }

function renderNote(initialPath: string, vault: Vault | undefined = EDIT_VAULT) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/vaults/:vaultId',
        element: <Outlet context={vault} />,
        children: [{ path: 'notes/*', element: <NoteView /> }],
      },
    ],
    { initialEntries: [initialPath] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function putCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
}

describe('NoteView', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders the frontmatter and an editable CodeMirror body (edit access)', async () => {
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

    await waitFor(() => expect(screen.getByText('type:')).toBeInTheDocument())
    const content = document.querySelector('.cm-content')
    expect(content).not.toBeNull()
    expect(content!.textContent).toContain('# Jane')
    expect(content!.textContent).toContain('Notes about Jane.')
    expect(content!.getAttribute('contenteditable')).toBe('true')
  })

  it('debounce-saves an edit to PUT /api/vaults/:id/notes/:path (edit access)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT')
        return Promise.resolve(mockJsonResponse(200, { id: 'n1', path: 'people/jane', frontmatter: {}, body: 'edited', updatedAt: '2026-01-02' }))
      return Promise.resolve(
        mockJsonResponse(200, { path: 'people/jane', frontmatter: {}, body: 'original', updatedAt: '2026-01-01' }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    renderNote('/vaults/v1/notes/people/jane', EDIT_VAULT)
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())

    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } })

    await vi.advanceTimersByTimeAsync(800)
    expect(putCalls(fetchMock)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(700)
    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/notes/people/jane',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ body: 'edited' }) }),
    )
  })

  it('read-only access: editor is non-editable and never saves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return Promise.resolve(mockJsonResponse(200, {}))
      return Promise.resolve(
        mockJsonResponse(200, { path: 'people/jane', frontmatter: { type: 'people' }, body: 'original', updatedAt: '2026-01-01' }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    renderNote('/vaults/v1/notes/people/jane', READ_VAULT)
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())

    expect(document.querySelector('.cm-content')!.getAttribute('contenteditable')).toBe('false')

    // Even a programmatic change (readOnly does not block dispatch) must not save.
    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'hacked' } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(putCalls(fetchMock)).toHaveLength(0)
  })

  it('shows a not-found message for a missing note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(404, { error: 'note not found' })))

    renderNote('/vaults/v1/notes/people/ghost')

    await waitFor(() => expect(screen.getByText('Note not found.')).toBeInTheDocument())
  })
})
```

- [ ] **Step 6: Run the NoteView tests, confirm the read-only one fails**

Run: `pnpm -C client test -- NoteView`
Expected: the "read-only access" test FAILS — `NoteView` doesn't derive
`readOnly` yet, so the editor stays editable (`contenteditable="true"`, not
`"false"`) and a programmatic change would schedule a save. (The other three
tests should pass; note the parent-`Outlet` router change keeps them working
because `useOutletContext`/`useParams` resolve the same.)

- [ ] **Step 7: Implement — derive `readOnly` and gate the save**

Replace `client/src/pages/vault/NoteView.tsx` with:
```tsx
import { useEffect, useRef } from 'react'
import { useOutletContext, useParams } from 'react-router'
import { useNote } from '../../hooks/useNote.js'
import { useUpdateNote } from '../../hooks/useUpdateNote.js'
import { useCodeMirrorEditor } from '../../hooks/useCodeMirrorEditor.js'
import { canEdit } from '../../api/vaults.js'
import type { Vault } from '../../api/vaults.js'

const SAVE_DEBOUNCE_MS = 1200

export function NoteView() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const path = useParams()['*']
  const vault = useOutletContext<Vault | undefined>()
  const note = useNote(vaultId!, path!)

  if (note.isPending) return null
  if (note.isError) return <div className="p-8 text-muted-foreground">Note not found.</div>

  // Conservative default: unknown access (vault undefined) => read-only.
  const readOnly = !canEdit(vault?.access)

  return (
    <NoteEditor
      // Remount key is the full note identity (vault + path) plus the edit
      // capability: keying on path alone would reuse a stale editor across a
      // cross-vault switch to the same path, and would also miss a change in
      // the user's access to this note (e.g. a live share revocation).
      key={`${vaultId}/${path}/${readOnly}`}
      vaultId={vaultId!}
      path={path!}
      vaultName={vault?.name}
      frontmatter={note.data!.frontmatter}
      initialBody={note.data!.body}
      readOnly={readOnly}
    />
  )
}

interface NoteEditorProps {
  vaultId: string
  path: string
  vaultName: string | undefined
  frontmatter: Record<string, unknown>
  initialBody: string
  readOnly: boolean
}

function NoteEditor({ vaultId, path, vaultName, frontmatter, initialBody, readOnly }: NoteEditorProps) {
  const updateNote = useUpdateNote(vaultId, path)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  function handleChange(newBody: string) {
    // Belt-and-suspenders: the editor is non-editable when readOnly, so this
    // shouldn't fire from user input — but never PUT an edit the server will
    // 404 anyway.
    if (readOnly) return
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      updateNote.mutate({ body: newBody })
    }, SAVE_DEBOUNCE_MS)
  }

  const editorRef = useCodeMirrorEditor({ doc: initialBody, onChange: handleChange, readOnly })

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-8 py-4 text-sm text-muted-foreground">
        {vaultName ?? vaultId} / <span className="text-foreground">{path}</span>
        {readOnly && <span className="ml-2 text-xs uppercase tracking-wide">· read-only</span>}
      </div>
      <div className="border-b border-border px-8 py-4">
        <dl className="flex flex-col gap-1 text-sm">
          {Object.entries(frontmatter).map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="font-medium text-muted-foreground">{key}:</dt>
              <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div ref={editorRef} className="flex-1 overflow-auto" />
    </div>
  )
}
```

- [ ] **Step 8: Run tests + typecheck + lint + build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm lint && pnpm -C client build`
Expected: all pass/exit 0 (full client suite green, root lint clean).

- [ ] **Step 9: Commit**

```bash
git add client/src/api/vaults.ts client/src/api/vaults.test.ts client/src/pages/vault/NoteView.tsx client/src/pages/vault/NoteView.test.tsx
git commit -m "Lock the note editor to read-only for read-access vaults"
```

---

### Task 3: Final verification + docs

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

In `README.md`, extend the editor status sentence (the one added in 2b-1 that
begins "Logged-in users can browse their vaults and edit notes with a real
CodeMirror 6 editor") to note that read-only users get a locked view. Replace
that sentence with:
```markdown
Logged-in users can browse their vaults and edit notes with a real
CodeMirror 6 editor (`/vaults/:id/notes/*`, debounced autosave); read-only
collaborators get the same note rendered but locked. The editable frontmatter
property panel, note create/rename/delete, and live-preview rendering arrive
in later UI sub-plans.
```
Also update the two "Status:" / "The UI ... is underway" lines that name the
completed slices to include "2b-2 (permission-aware editor lock)" alongside
2b-1, keeping the "next" list as the remaining 2b work (property panel, note
lifecycle, live-preview).

- [ ] **Step 3: Update STATE.md**

Update `docs/agents/STATE.md` to record Slice 2b-2 complete and name the next
increment (2b-3: editable frontmatter property panel, then 2b-4: note
create/rename/delete). Keep the file at or under 40 lines.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/agents/STATE.md
git commit -m "Update README and STATE.md for Slice 2b-2"
```

---

## Self-Review

**Spec coverage:** Editor spec §"Permission-aware rendering" for the *body* is
covered — `read`-only opens non-editable with no autosave (Task 2's editor
`readOnly` + save guard), `edit`/`owner` keep the full editor. The spec's
"property panel also locked" clause is only partially in play here because the
property panel is still the read-only `<dl>` display (it becomes editable in
2b-3, at which point *its* lock lands) — this is consistent with the increment
boundary, not a silent gap. "No create/rename/delete affordances for read-only"
is trivially satisfied because those affordances don't exist yet (2b-4).

**Placeholder scan:** no TBD/TODO; every code step is complete and runnable.

**Type consistency:** `canEdit(access: VaultAccess | undefined): boolean`
(Task 2) is used in `NoteView` exactly as defined. `useCodeMirrorEditor`'s new
`readOnly?: boolean` option (Task 1) matches how `NoteView` passes it (Task 2).
The `readOnly` boolean threads: derived in `NoteView` → `NoteEditor` prop →
`handleChange` guard + `useCodeMirrorEditor({ readOnly })` + remount key.

**Known limitation (documented, not a gap):** `readOnly` is captured at editor
mount; because it's part of the remount `key`, a change in the user's access to
the open note re-derives and remounts with the new state on the next render —
but only once the vault list (and thus `Vault.access`) refetches. Live,
instant mid-view revocation is the Real-time-collaboration sub-project's
concern (instant permission kick), not this REST single-user path.
