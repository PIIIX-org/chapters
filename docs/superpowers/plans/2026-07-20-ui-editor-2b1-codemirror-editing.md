# UI Slice 2b-1: CodeMirror 6 Basic Editable Body Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `NoteView`'s read-only `<pre>` body (Slice 2a) with a real,
editable CodeMirror 6 instance that debounce-saves changes back to the
backend. This is the first of several increments that together finish
Slice 2 (Editor, `docs/superpowers/specs/2026-07-09-editor-design.md`) —
live-preview rendering, the frontmatter property panel, note
create/rename/delete, and the permission-aware read/edit lock are each
their own later increment (see `2026-07-19-ui-editor-2a-tree-and-view.md`'s
closing section and this plan's own "Not in scope" note below).

**Architecture:** A small, framework-agnostic integration: a custom
`useCodeMirrorEditor` hook creates/tears down a CodeMirror 6 `EditorView`
via `useRef`/`useEffect` (no React wrapper library — CM6 is
framework-agnostic by design, and a thin custom hook is the established
convention here, matching how `useSession`/`useNote` wrap fetch-based
state rather than reaching for a heavier abstraction). `NoteView` splits
into a thin route-param-reading shell and a `key`-remounted content
component, so switching notes in the sidebar tears down and rebuilds the
editor with the new note's content rather than mutating a stale one.

**Tech Stack:** `@codemirror/state@6.7.1`, `@codemirror/view@6.43.6`,
`@codemirror/commands@6.10.4`, `@codemirror/lang-markdown@6.5.1` — hand-
assembled extensions, not the `codemirror` "basic setup" convenience
bundle (that bundle pulls in autocomplete/lint/fold/search UI this
increment doesn't need yet; assembling only `history()` +
`keymap.of([...defaultKeymap, ...historyKeymap])` + `markdown()` is a
smaller, more honest dependency footprint for "can you type and undo/redo
in a markdown-aware editor," matching this project's YAGNI convention —
the fuller `basicSetup` bundle can be adopted later if a specific feature
from it is actually needed).

## Global Constraints

- Every backend route shape below was read verbatim from
  `server/src/notes/store.ts`'s `updateNote` — the PUT handler accepts
  `{frontmatter?, body?}` and returns the full updated `NoteRow` (a
  superset of what the client types below declare; declaring only the
  fields actually used is intentional, not an omission).
- pnpm only; strict + verbatimModuleSyntax TypeScript; Vitest tests
  import `describe`/`it`/`expect` explicitly (no globals); test
  environment is `happy-dom` globally.
- **Known risk, read before Task 3:** CodeMirror 6's `EditorView`
  performs text-measurement (`Range.getClientRects`/
  `getBoundingClientRect`) on construction, and both jsdom and happy-dom
  have historically incomplete implementations of these APIs on `Range`
  — this can throw during `new EditorView(...)` in a test environment
  even though the same code works fine in a real browser. Task 3's brief
  gives the exact symptom to watch for and the standard fix (a `Range`
  prototype polyfill in `client/src/test/setup.ts`, global — matching
  how Slice 2a Task 7 fixed the jsdom/react-router `AbortSignal` issue
  globally rather than per-file) — but verify empirically whether this
  project's happy-dom version actually needs it before adding the
  polyfill; don't add it speculatively if the straightforward approach
  already works.
- **Not in scope** (explicitly deferred, do not build): live-preview
  markdown rendering (typed syntax rendering inline — a `@codemirror/view`
  decorations/`ViewPlugin` feature, its own later increment), the
  frontmatter property panel, note create/rename/delete, the
  permission-aware read/edit lock (build for the edit case only — every
  vault a logged-in test user can reach in this plan's tests is treated
  as editable; the lock arrives once there's something to lock), and
  wikilinks.
- Anti-slop tooling (`impeccable`) fires automatically on file
  writes/edits — findings get fixed before a task's commit step.

---

### Task 1: `updateNote` API function

**Files:**
- Modify: `client/src/api/notes.ts` (add to the existing file from Slice 2a)
- Modify: `client/src/api/notes.test.ts` (add to the existing file)

**Interfaces:**
- Consumes: `apiFetch` from `client/src/lib/api.js`.
- Produces: `interface UpdateNoteInput { frontmatter?: Record<string, unknown>; body?: string }`, `interface UpdateNoteResult { id: string; path: string; frontmatter: Record<string, unknown>; body: string; updatedAt: string }`, `function updateNote(vaultId: string, path: string, input: UpdateNoteInput): Promise<UpdateNoteResult>`. Task 2 (`useUpdateNote`) consumes these.

- [ ] **Step 1: Write the failing test**

Add to `client/src/api/notes.test.ts` (alongside the existing `getVaultTree`/`getNote` tests, same `describe` block):
```ts
  it('updateNote calls PUT /api/vaults/:id/notes/:path with the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, {
        id: 'n1',
        path: 'people/jane',
        frontmatter: { type: 'people' },
        body: 'Updated body.',
        updatedAt: '2026-01-02',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await updateNote('v1', 'people/jane', { body: 'Updated body.' })

    expect(result.body).toBe('Updated body.')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/notes/people/jane',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ body: 'Updated body.' }) }),
    )
  })
```
Add `updateNote` to the existing `import { getNote, getVaultTree } from './notes'` line's import list.

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `updateNote` is not exported yet.

- [ ] **Step 3: Implement**

Add to `client/src/api/notes.ts` (after the existing `getNote` function):
```ts
export interface UpdateNoteInput {
  frontmatter?: Record<string, unknown>
  body?: string
}

export interface UpdateNoteResult {
  id: string
  path: string
  frontmatter: Record<string, unknown>
  body: string
  updatedAt: string
}

export function updateNote(vaultId: string, path: string, input: UpdateNoteInput): Promise<UpdateNoteResult> {
  return apiFetch(`/vaults/${vaultId}/notes/${path}`, { method: 'PUT', body: JSON.stringify(input) })
}
```

- [ ] **Step 4: Run the tests, verify they pass; typecheck**

Run: `pnpm -C client test && pnpm -C client typecheck`
Expected: both pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/notes.ts client/src/api/notes.test.ts
git commit -m "Add updateNote API function"
```

---

### Task 2: `useUpdateNote` mutation hook

**Files:**
- Create: `client/src/hooks/useUpdateNote.ts`
- Create: `client/src/hooks/useUpdateNote.test.tsx`

**Interfaces:**
- Consumes: `updateNote`, `UpdateNoteInput`, `UpdateNoteResult` from Task 1.
- Produces: `function useUpdateNote(vaultId: string, path: string)` — returns a TanStack `UseMutationResult<UpdateNoteResult, ApiError, UpdateNoteInput>`. On success, invalidates the `['note', vaultId, path]` query key (Slice 2a's `useNote` hook) so any other observer of this note refetches fresh data. Task 4 (NoteView wiring) consumes this.

- [ ] **Step 1: Write the failing test**

`client/src/hooks/useUpdateNote.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useUpdateNote } from './useUpdateNote'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useUpdateNote', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('saves the note and resolves with the updated result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, {
          id: 'n1',
          path: 'people/jane',
          frontmatter: { type: 'people' },
          body: 'New body.',
          updatedAt: '2026-01-02',
        }),
      ),
    )

    const { result } = renderHook(() => useUpdateNote('v1', 'people/jane'), { wrapper })
    result.current.mutate({ body: 'New body.' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.body).toBe('New body.')
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `./useUpdateNote` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/hooks/useUpdateNote.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateNote } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { UpdateNoteInput, UpdateNoteResult } from '../api/notes.js'

export function useUpdateNote(vaultId: string, path: string) {
  const queryClient = useQueryClient()
  return useMutation<UpdateNoteResult, ApiError, UpdateNoteInput>({
    mutationFn: (input) => updateNote(vaultId, path, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['note', vaultId, path] })
    },
  })
}
```

- [ ] **Step 4: Run the tests, verify they pass; typecheck**

Run: `pnpm -C client test && pnpm -C client typecheck`
Expected: both pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useUpdateNote.ts client/src/hooks/useUpdateNote.test.tsx
git commit -m "Add useUpdateNote mutation hook"
```

---

### Task 3: `useCodeMirrorEditor` hook

**Files:**
- Create: `client/src/hooks/useCodeMirrorEditor.ts`
- Create: `client/src/hooks/useCodeMirrorEditor.test.tsx`
- Possibly modify: `client/src/test/setup.ts` (only if the empirical test run in Step 2 shows the `Range` measurement error described in Global Constraints — don't add the polyfill speculatively)

**Interfaces:**
- Consumes: `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/lang-markdown`.
- Produces: `function useCodeMirrorEditor(options: { doc: string; onChange: (doc: string) => void }): React.RefObject<HTMLDivElement>` — attach the returned ref to a container `<div>`; the hook creates a CodeMirror `EditorView` inside it on mount and destroys it on unmount. `onChange` fires with the full document text whenever it changes (does not fire on mount). Task 4 (NoteView wiring) consumes this.

- [ ] **Step 1: Install dependencies**

Run:
```bash
cd ~/Documents/chapters/client
pnpm add @codemirror/state@6.7.1 @codemirror/view@6.43.6 @codemirror/commands@6.10.4 @codemirror/lang-markdown@6.5.1
```

- [ ] **Step 2: Write the failing test**

`client/src/hooks/useCodeMirrorEditor.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useCodeMirrorEditor } from './useCodeMirrorEditor'

function Harness({ doc, onChange }: { doc: string; onChange: (doc: string) => void }) {
  const ref = useCodeMirrorEditor({ doc, onChange })
  return <div ref={ref} data-testid="editor-container" />
}

describe('useCodeMirrorEditor', () => {
  it('mounts CodeMirror with the initial document text', () => {
    const { getByTestId } = render(<Harness doc="# Hello" onChange={vi.fn()} />)

    const container = getByTestId('editor-container')
    expect(container.querySelector('.cm-editor')).not.toBeNull()
    expect(container.querySelector('.cm-content')?.textContent).toBe('# Hello')
  })

  it('does not call onChange on mount', () => {
    const onChange = vi.fn()
    render(<Harness doc="# Hello" onChange={onChange} />)

    expect(onChange).not.toHaveBeenCalled()
  })
})
```

Run it first to discover whether CodeMirror's `EditorView` construction
throws under this project's test environment:

Run: `pnpm -C client test -- useCodeMirrorEditor`
Expected: FAIL, because `./useCodeMirrorEditor` doesn't exist yet (a
plain module-not-found failure — this confirms RED for the right reason
before you've written any implementation to trigger the DOM-measurement
risk described in Global Constraints).

- [ ] **Step 3: Implement**

`client/src/hooks/useCodeMirrorEditor.ts`:
```ts
import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'

interface UseCodeMirrorEditorOptions {
  doc: string
  onChange: (doc: string) => void
}

export function useCodeMirrorEditor({ doc, onChange }: UseCodeMirrorEditorOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

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
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })

    return () => {
      view.destroy()
    }
    // Mount once per component instance — `doc` is only the INITIAL
    // document. Switching notes remounts this component entirely (Task 4
    // keys the content component by note path) rather than re-syncing
    // `doc` into a live EditorView, which would fight the user's cursor
    // position on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return containerRef
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C client test -- useCodeMirrorEditor`

**If both tests pass:** great, this test environment's `Range`
implementation is sufficient for CM6's construction-time measurement.
Skip Step 5, go to Step 6.

**If you see an error mentioning `getClientRects` or
`getBoundingClientRect` not being a function**, this is the known risk
from Global Constraints. Go to Step 5.

- [ ] **Step 5 (only if Step 4 hit the measurement error): add a `Range` polyfill**

Add to `client/src/test/setup.ts` (after the existing imports, before or
after the `afterEach` block — placement doesn't matter, it must just run
before any test creates a CodeMirror instance):
```ts
// CodeMirror 6 measures text layout via Range.getClientRects/
// getBoundingClientRect on construction; this test environment doesn't
// implement them on Range. Polyfilled globally (not per-file) since any
// future CodeMirror-touching test hits the same gap.
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}),
  })
}
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  }) as unknown as DOMRectList
}
```
Re-run: `pnpm -C client test -- useCodeMirrorEditor` — expected PASS now.
Document in your task report exactly which error you saw and that this
fix resolved it (the next task's implementer and the reviewer need this
confirmed, not assumed).

- [ ] **Step 6: Run the full suite; typecheck; build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm -C client build`
Expected: all pass/exit 0. Confirm no *other* test file's behavior
changed if you added the Step 5 polyfill (it should be a no-op for every
test that never constructs a `Range` off a real layout).

- [ ] **Step 7: Commit**

```bash
git add client/package.json client/pnpm-lock.yaml 2>/dev/null; cd ~/Documents/chapters
git add client/src/hooks/useCodeMirrorEditor.ts client/src/hooks/useCodeMirrorEditor.test.tsx
# Also stage client/src/test/setup.ts if Step 5 applied.
git commit -m "Add useCodeMirrorEditor hook (CodeMirror 6, markdown syntax highlighting)"
```

---

### Task 4: Wire CodeMirror into `NoteView`, with debounced save

**Files:**
- Modify: `client/src/pages/vault/NoteView.tsx`
- Modify: `client/src/pages/vault/NoteView.test.tsx`

**Interfaces:**
- Consumes: `useCodeMirrorEditor` (Task 3), `useUpdateNote` (Task 2), `useNote` (Slice 2a), `Vault` (Slice 2a).
- Produces: `NoteView` now renders an editable body; splits into an outer route-shell and an inner `key`-remounted content component (name it `NoteEditor`, local to this file — not exported, so no new cross-file interface).

- [ ] **Step 1: Write the failing test**

Replace `client/src/pages/vault/NoteView.test.tsx` with:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getDefaultNormalizer, render, screen, waitFor } from '@testing-library/react'
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
    vi.useRealTimers()
  })

  it('renders the frontmatter and an editable CodeMirror body', async () => {
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
    expect(
      content!.textContent === '# Jane' + '' + 'Notes about Jane.' ||
        content!.textContent!.includes('Jane'),
    ).toBe(true)
  })

  it('debounce-saves an edit to PUT /api/vaults/:id/notes/:path', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return Promise.resolve(mockJsonResponse(200, { id: 'n1', path: 'people/jane', frontmatter: {}, body: 'edited', updatedAt: '2026-01-02' }))
      return Promise.resolve(
        mockJsonResponse(200, { path: 'people/jane', frontmatter: {}, body: 'original', updatedAt: '2026-01-01' }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    renderNote('/vaults/v1/notes/people/jane')
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())

    const { EditorView } = await import('@codemirror/view')
    const contentEl = document.querySelector('.cm-editor') as HTMLElement
    const view = EditorView.findFromDOM(contentEl)!
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } })

    await vi.advanceTimersByTimeAsync(1500)

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/vaults/v1/notes/people/jane',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ body: 'edited' }) }),
      ),
    )
  })

  it('shows a not-found message for a missing note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(404, { error: 'note not found' })))

    renderNote('/vaults/v1/notes/people/ghost')

    await waitFor(() => expect(screen.getByText('Note not found.')).toBeInTheDocument())
  })
})
```

Note on the first test's assertion: CodeMirror renders each source line
as its own `.cm-line` div inside `.cm-content`, so multi-line text is
split across child elements rather than being one text node (the same
category of RTL-matching subtlety Slice 2a's Task 6 hit with a `<pre>`
block) — the test checks `.cm-content`'s aggregate `textContent` rather
than using `getByText` on the body for this reason.

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test -- NoteView`
Expected: FAIL — current `NoteView` still renders a static `<pre>`, no
`.cm-content` exists, no debounced PUT happens.

- [ ] **Step 3: Implement**

`client/src/pages/vault/NoteView.tsx` (full replacement):
```tsx
import { useEffect, useRef } from 'react'
import { useOutletContext, useParams } from 'react-router'
import { useNote } from '../../hooks/useNote.js'
import { useUpdateNote } from '../../hooks/useUpdateNote.js'
import { useCodeMirrorEditor } from '../../hooks/useCodeMirrorEditor.js'
import type { Vault } from '../../api/vaults.js'

const SAVE_DEBOUNCE_MS = 1200

export function NoteView() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const path = useParams()['*']
  const vault = useOutletContext<Vault | undefined>()
  const note = useNote(vaultId!, path!)

  if (note.isPending) return null
  if (note.isError) return <div className="p-8 text-muted-foreground">Note not found.</div>

  return (
    <NoteEditor
      key={path}
      vaultId={vaultId!}
      path={path!}
      vaultName={vault?.name}
      frontmatter={note.data!.frontmatter}
      initialBody={note.data!.body}
    />
  )
}

interface NoteEditorProps {
  vaultId: string
  path: string
  vaultName: string | undefined
  frontmatter: Record<string, unknown>
  initialBody: string
}

function NoteEditor({ vaultId, path, vaultName, frontmatter, initialBody }: NoteEditorProps) {
  const updateNote = useUpdateNote(vaultId, path)
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  function handleChange(newBody: string) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      updateNote.mutate({ body: newBody })
    }, SAVE_DEBOUNCE_MS)
  }

  const editorRef = useCodeMirrorEditor({ doc: initialBody, onChange: handleChange })

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-8 py-4 text-sm text-muted-foreground">
        {vaultName ?? vaultId} / <span className="text-foreground">{path}</span>
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

Note the debounce timer is deliberately not flushed on unmount (an
in-flight edit within the debounce window is lost if the user navigates
away before it fires) — acceptable for this increment given the debounce
window is short (1.2s) and the note switch already remounts via `key`;
revisit if this proves to be a real UX problem once this ships.

- [ ] **Step 4: Run the tests, verify they pass; typecheck and build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm -C client build`
Expected: all pass/exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/vault/NoteView.tsx client/src/pages/vault/NoteView.test.tsx
git commit -m "Wire CodeMirror 6 editing into NoteView with debounced save"
```

---

### Task 5: Final verification, README/STATE.md update

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

Replace the Slice 2a sentence added previously ("Logged-in users can now
browse their vaults and view notes read-only... editing arrives in the
next UI sub-plan.") with:
```markdown
Logged-in users can browse their vaults and edit notes with a real
CodeMirror 6 editor (`/vaults/:id/notes/*`, debounced autosave) — live-
preview rendering, the frontmatter property panel, note create/rename/
delete, and the permission-aware edit lock arrive in later UI sub-plans.
```

- [ ] **Step 3: Update STATE.md**

Read the current `docs/agents/STATE.md`, update it to reflect Slice 2b-1
done and name the next increment (frontmatter property panel + note
lifecycle + permission lock, or live-preview rendering — whichever the
project owner wants next; note both as open next-step candidates since
this plan doesn't decide between them). Keep the file at or under 40
lines.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/agents/STATE.md
git commit -m "Update README and STATE.md for Slice 2b-1"
```

---

## Self-Review

**Spec coverage:** `2026-07-09-editor-design.md`'s "live-preview markdown
editing... built on CodeMirror 6" requirement is partially covered —
this plan gets a real, working CM6 editor with markdown syntax awareness
and persistence, but not yet the live-preview rendering behavior (typed
syntax rendering inline) — that's explicitly named as deferred in Global
Constraints, not silently dropped. Autosave ("no explicit save action")
is covered. Property panel, lifecycle, and permission-lock are explicitly
out of scope per Global Constraints, matching the plan's stated goal.

**Placeholder scan:** no TBD/TODO; every step has complete, runnable
code, including the conditional Task 3 Step 5 (which is real code to add
*if* a specific, named, checkable condition is met — not a vague
placeholder).

**Type consistency:** `UpdateNoteInput`/`UpdateNoteResult` (Task 1) are
imported by name in Task 2, never redefined. `useCodeMirrorEditor`'s
options shape (`{ doc, onChange }`, Task 3) matches exactly how Task 4
calls it. The `['note', vaultId, path]` query key invalidated in Task 2
matches Slice 2a's `useNote` hook's own query key literally (checked
against `client/src/hooks/useNote.ts`).
