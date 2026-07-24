# UI Slice 2b-3: Editable Frontmatter Property Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `NoteView`'s read-only frontmatter `<dl>` with a structured,
editable property panel — typed fields for the standard OKF keys (`resource`,
`tags`, `timestamp`) that debounce-save via `PUT {frontmatter}`, respecting the
2b-2 read-only lock, while preserving `type` and any extra keys.

**Architecture:** A self-contained `PropertyPanel` widget (like the CM6 body: it
owns its edit state and its own debounced save via `useUpdateNote`) plus a small
controlled `TagInput` chip component. `NoteView` swaps the `<dl>` for the panel
and passes `vaultId`/`path`/`frontmatter`/`readOnly`. The body editor path is
untouched.

**Tech Stack:** React (`useState`/`useRef`), TanStack Query mutation
(`useUpdateNote`), the existing `Input`/`Label` UI primitives, Vitest +
happy-dom.

## Global Constraints

- **Backend contract (read verbatim from `server/src/notes/store.ts`
  `updateNote` + `server/src/notes/okf.ts`):**
  - `PUT /vaults/:id/notes/*` accepts `{ frontmatter?, body? }`. When
    `frontmatter` is provided, the server **replaces** the note's frontmatter
    with it (`{ ...input.frontmatter, type: row.type }`) — so the panel MUST
    send the *complete* frontmatter (edited standard keys **plus** every
    preserved key), or unsent keys are dropped.
  - The server **forces `frontmatter.type = row.type`** on every update — so
    `type` is **immutable** through this path. The panel shows `type`
    read-only; changing a note's type is a move/rename operation (a later
    lifecycle increment, 2b-4), not a frontmatter edit.
  - OKF validation (server-side, authoritative): `tags` must be a string array;
    `timestamp` must be an ISO date string (`Date.parse`-able); `resource` must
    be a string; every key must be a scalar or list of scalars. The panel's
    typed fields produce valid OKF by construction; the server remains the
    validation authority.
- **Respect the 2b-2 lock:** when `readOnly`, every field is disabled and no
  save is scheduled (mirrors the body editor's `readOnly` behavior).
- **Autosave** (editor spec §Note-lifecycle "Edit"): debounced shortly after
  the user stops typing, no explicit save button. Use the same `1200ms` window
  as the body (`SAVE_DEBOUNCE_MS`).
- pnpm only; strict TS + `verbatimModuleSyntax` (type-only imports use
  `import type`); Vitest tests import `describe`/`it`/`expect` explicitly (no
  globals); happy-dom test env. Root `pnpm lint` must be clean before each
  commit (per-task gate includes lint).
- Use existing UI primitives (`client/src/components/ui/input.tsx`,
  `label.tsx`) and design tokens (`bg-muted`, `text-muted-foreground`,
  `border-border`, etc.) — do not invent styles or add dependencies.
- **Out of scope** (defer, do not build): editing/adding/removing *arbitrary
  extra* frontmatter keys (extra keys are preserved + shown read-only here);
  changing `type`; a native date-picker for `timestamp` (plain ISO text input
  for now); note create/rename/delete (2b-4); live-preview; wikilinks (2c).
- Anti-slop tooling (`impeccable`) fires on writes/edits — fix findings before
  each commit.

---

### Task 1: `TagInput` chip component

**Files:**
- Create: `client/src/components/vault/TagInput.tsx`
- Create: `client/src/components/vault/TagInput.test.tsx`

**Interfaces:**
- Consumes: `Input` from `../ui/input`.
- Produces: `TagInput({ value, onChange, disabled? })` — `value: string[]`,
  `onChange: (tags: string[]) => void`, `disabled?: boolean`. Renders each tag
  as a removable chip; typing a tag and pressing Enter appends it (deduped,
  trimmed); when `disabled`, chips render without remove buttons and no input is
  shown. Task 2 (`PropertyPanel`) consumes it.

- [ ] **Step 1: Write the failing tests**

`client/src/components/vault/TagInput.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TagInput } from './TagInput'

describe('TagInput', () => {
  it('renders existing tags as chips', () => {
    render(<TagInput value={['alpha', 'beta']} onChange={vi.fn()} />)
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
  })

  it('adds a trimmed tag on Enter and clears the input', () => {
    const onChange = vi.fn()
    render(<TagInput value={['alpha']} onChange={onChange} />)
    const input = screen.getByPlaceholderText('Add tag…')
    fireEvent.change(input, { target: { value: '  gamma  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['alpha', 'gamma'])
  })

  it('does not add a duplicate tag', () => {
    const onChange = vi.fn()
    render(<TagInput value={['alpha']} onChange={onChange} />)
    const input = screen.getByPlaceholderText('Add tag…')
    fireEvent.change(input, { target: { value: 'alpha' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes a tag when its remove button is clicked', () => {
    const onChange = vi.fn()
    render(<TagInput value={['alpha', 'beta']} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Remove alpha'))
    expect(onChange).toHaveBeenCalledWith(['beta'])
  })

  it('shows no input and no remove buttons when disabled', () => {
    render(<TagInput value={['alpha']} onChange={vi.fn()} disabled />)
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Add tag…')).toBeNull()
    expect(screen.queryByLabelText('Remove alpha')).toBeNull()
  })
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `pnpm -C client test -- TagInput`
Expected: FAIL — `./TagInput` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/components/vault/TagInput.tsx`:
```tsx
import { useState } from 'react'
import { Input } from '../ui/input'

interface TagInputProps {
  value: string[]
  onChange: (tags: string[]) => void
  disabled?: boolean
}

export function TagInput({ value, onChange, disabled }: TagInputProps) {
  const [draft, setDraft] = useState('')

  function addTag() {
    const tag = draft.trim()
    if (tag && !value.includes(tag)) onChange([...value, tag])
    setDraft('')
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
        >
          {tag}
          {!disabled && (
            <button
              type="button"
              onClick={() => onChange(value.filter((t) => t !== tag))}
              aria-label={`Remove ${tag}`}
              className="text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addTag()
            }
          }}
          placeholder="Add tag…"
          className="h-6 w-28 flex-1"
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm -C client test -- TagInput && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/vault/TagInput.tsx client/src/components/vault/TagInput.test.tsx
git commit -m "Add TagInput chip component"
```

---

### Task 2: `PropertyPanel` component

**Files:**
- Create: `client/src/components/vault/PropertyPanel.tsx`
- Create: `client/src/components/vault/PropertyPanel.test.tsx`

**Interfaces:**
- Consumes: `TagInput` (Task 1); `useUpdateNote` from `../../hooks/useUpdateNote`;
  `Input` from `../ui/input`, `Label` from `../ui/label`.
- Produces: `PropertyPanel({ vaultId, path, initialFrontmatter, readOnly })` —
  `initialFrontmatter: Record<string, unknown>`, `readOnly: boolean`. Shows
  `type` read-only; edits `resource`/`timestamp` (text) and `tags` (`TagInput`);
  preserves `type` + any extra keys; debounce-saves the *complete* frontmatter
  via `PUT {frontmatter}`. When `readOnly`, all fields are disabled and no save
  is scheduled. Task 3 (`NoteView`) consumes it.

- [ ] **Step 1: Write the failing tests**

`client/src/components/vault/PropertyPanel.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../../lib/api'
import { PropertyPanel } from './PropertyPanel'

function renderPanel(frontmatter: Record<string, unknown>, readOnly = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <PropertyPanel vaultId="v1" path="people/jane" initialFrontmatter={frontmatter} readOnly={readOnly} />
    </QueryClientProvider>,
  )
}

function putBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string))
}

describe('PropertyPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shows type read-only and renders the standard fields', () => {
    renderPanel({ type: 'people', resource: 'https://x.test', tags: ['a'], timestamp: '2026-01-01' })
    // type shown but not as an editable input
    expect(screen.getByText('people')).toBeInTheDocument()
    expect(screen.getByDisplayValue('https://x.test')).toBeInTheDocument()
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByDisplayValue('2026-01-01')).toBeInTheDocument()
  })

  it('debounce-saves the full frontmatter, preserving type and extra keys, when resource changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'n1', path: 'people/jane', frontmatter: {}, body: '', updatedAt: '2026-01-02' }))
    vi.stubGlobal('fetch', fetchMock)

    renderPanel({ type: 'people', resource: 'old', tags: ['a'], timestamp: '2026-01-01', custom: 'keep' })

    fireEvent.change(screen.getByDisplayValue('old'), { target: { value: 'new' } })

    await vi.advanceTimersByTimeAsync(500)
    expect(putBodies(fetchMock)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(800)
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1))
    expect(putBodies(fetchMock)[0]).toEqual({
      frontmatter: { type: 'people', custom: 'keep', resource: 'new', tags: ['a'], timestamp: '2026-01-01' },
    })
  })

  it('omits emptied optional keys from the saved frontmatter', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'n1', path: 'people/jane', frontmatter: {}, body: '', updatedAt: '2026-01-02' }))
    vi.stubGlobal('fetch', fetchMock)

    renderPanel({ type: 'people', resource: 'old' })

    fireEvent.change(screen.getByDisplayValue('old'), { target: { value: '' } })
    await vi.advanceTimersByTimeAsync(1300)

    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1))
    expect(putBodies(fetchMock)[0]).toEqual({ frontmatter: { type: 'people' } })
  })

  it('disables fields and never saves when readOnly', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    renderPanel({ type: 'people', resource: 'ro' }, true)

    const resourceInput = screen.getByDisplayValue('ro') as HTMLInputElement
    expect(resourceInput.disabled).toBe(true)
    // A change that slips through must not schedule a save.
    fireEvent.change(resourceInput, { target: { value: 'x' } })
    await vi.advanceTimersByTimeAsync(1300)
    expect(putBodies(fetchMock)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `pnpm -C client test -- PropertyPanel`
Expected: FAIL — `./PropertyPanel` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/components/vault/PropertyPanel.tsx`:
```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { TagInput } from './TagInput'
import { useUpdateNote } from '../../hooks/useUpdateNote'

const SAVE_DEBOUNCE_MS = 1200

interface PropertyPanelProps {
  vaultId: string
  path: string
  initialFrontmatter: Record<string, unknown>
  readOnly: boolean
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function PropertyPanel({ vaultId, path, initialFrontmatter, readOnly }: PropertyPanelProps) {
  const updateNote = useUpdateNote(vaultId, path)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Everything except the three editable standard keys is preserved as-is
  // (`type` — immutable server-side — and any extra OKF keys).
  const preserved = useMemo(() => {
    const { resource: _r, tags: _t, timestamp: _ts, ...rest } = initialFrontmatter
    return rest
  }, [initialFrontmatter])

  const [resource, setResource] = useState(asString(initialFrontmatter.resource))
  const [tags, setTags] = useState<string[]>(asStringArray(initialFrontmatter.tags))
  const [timestamp, setTimestamp] = useState(asString(initialFrontmatter.timestamp))

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  function scheduleSave(next: { resource: string; tags: string[]; timestamp: string }) {
    if (readOnly) return
    const frontmatter: Record<string, unknown> = { ...preserved }
    if (next.resource.trim()) frontmatter.resource = next.resource.trim()
    if (next.tags.length) frontmatter.tags = next.tags
    if (next.timestamp.trim()) frontmatter.timestamp = next.timestamp.trim()
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => updateNote.mutate({ frontmatter }), SAVE_DEBOUNCE_MS)
  }

  function onResource(v: string) {
    setResource(v)
    scheduleSave({ resource: v, tags, timestamp })
  }
  function onTags(v: string[]) {
    setTags(v)
    scheduleSave({ resource, tags: v, timestamp })
  }
  function onTimestamp(v: string) {
    setTimestamp(v)
    scheduleSave({ resource, tags, timestamp: v })
  }

  const extraKeys = Object.entries(preserved).filter(([key]) => key !== 'type')

  return (
    <dl className="grid grid-cols-[6rem_1fr] items-center gap-x-4 gap-y-2 text-sm">
      <dt className="font-medium text-muted-foreground">type</dt>
      <dd className="text-foreground">{asString(initialFrontmatter.type) || '—'}</dd>

      <Label htmlFor="pp-resource" className="text-muted-foreground">resource</Label>
      <Input
        id="pp-resource"
        value={resource}
        disabled={readOnly}
        onChange={(e) => onResource(e.target.value)}
      />

      <dt className="font-medium text-muted-foreground">tags</dt>
      <dd>
        <TagInput value={tags} onChange={onTags} disabled={readOnly} />
      </dd>

      <Label htmlFor="pp-timestamp" className="text-muted-foreground">timestamp</Label>
      <Input
        id="pp-timestamp"
        value={timestamp}
        disabled={readOnly}
        placeholder="ISO date (e.g. 2026-01-01)"
        onChange={(e) => onTimestamp(e.target.value)}
      />

      {extraKeys.map(([key, value]) => (
        <div key={key} className="col-span-2 flex gap-2">
          <dt className="font-medium text-muted-foreground">{key}:</dt>
          <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
        </div>
      ))}
    </dl>
  )
}
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm -C client test -- PropertyPanel && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/vault/PropertyPanel.tsx client/src/components/vault/PropertyPanel.test.tsx
git commit -m "Add editable PropertyPanel component (frontmatter autosave)"
```

---

### Task 3: Wire `PropertyPanel` into `NoteView`

**Files:**
- Modify: `client/src/pages/vault/NoteView.tsx`
- Modify: `client/src/pages/vault/NoteView.test.tsx`

**Interfaces:**
- Consumes: `PropertyPanel` (Task 2).
- Produces: `NoteView` renders the editable panel instead of the read-only
  `<dl>`; no new exported interface.

- [ ] **Step 1: Update the NoteView tests**

In `client/src/pages/vault/NoteView.test.tsx`, the first test currently asserts
the old `<dl>` label via `screen.getByText('type:')`. Replace that assertion so
it targets the panel instead. Change the block:
```tsx
    await waitFor(() => expect(screen.getByText('type:')).toBeInTheDocument())
    const content = document.querySelector('.cm-content')
```
to:
```tsx
    await waitFor(() => expect(screen.getByText('people')).toBeInTheDocument())
    // property panel is present (type shown read-only, resource field editable)
    expect(screen.getByText('resource')).toBeInTheDocument()
    const content = document.querySelector('.cm-content')
```
(The mocked note in that test has `frontmatter: { type: 'people', timestamp: ... }`,
so `people` renders as the read-only type value and `resource` is a panel label.)

- [ ] **Step 2: Run, confirm the first test fails**

Run: `pnpm -C client test -- NoteView`
Expected: the "renders the frontmatter and an editable CodeMirror body" test
FAILS — `NoteView` still renders the old `<dl>` (with "type:" dt), so
`getByText('resource')` finds nothing. Other tests still pass.

- [ ] **Step 3: Implement — swap the `<dl>` for `PropertyPanel`**

In `client/src/pages/vault/NoteView.tsx`: add the import
```tsx
import { PropertyPanel } from '../../components/vault/PropertyPanel.js'
```
and replace the entire frontmatter `<div>`/`<dl>` block (the one wrapping the
`Object.entries(frontmatter).map(...)` list) with:
```tsx
      <div className="border-b border-border px-8 py-4">
        <PropertyPanel
          vaultId={vaultId}
          path={path}
          initialFrontmatter={frontmatter}
          readOnly={readOnly}
        />
      </div>
```
Leave everything else (the breadcrumb, the CM6 body `<div ref={editorRef} …>`,
the body debounce/save) exactly as is.

- [ ] **Step 4: Run tests + typecheck + lint + build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm lint && pnpm -C client build`
Expected: all pass/exit 0 (full client suite green).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/vault/NoteView.tsx client/src/pages/vault/NoteView.test.tsx
git commit -m "Render editable PropertyPanel in NoteView"
```

---

### Task 4: Final verification + docs

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

Update the editor status sentence (the one beginning "Logged-in users can browse
their vaults and edit notes with a real CodeMirror 6 editor") to mention the
editable property panel, and update the two slice-status lines to list Slice
2b-3 (editable frontmatter property panel) among the done slices, with the
remaining 2b work (note create/rename/delete, live-preview) as next. Keep the
copy accurate to what shipped: `type` is shown read-only, standard fields
(`resource`/`tags`/`timestamp`) are editable and autosave, extra keys are
preserved.

- [ ] **Step 3: Update STATE.md**

Record Slice 2b-3 complete and name the next increment (2b-4: note
create/rename/delete in the file tree). Keep the file at or under 40 lines.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/agents/STATE.md
git commit -m "Update README and STATE.md for Slice 2b-3"
```

---

## Self-Review

**Spec coverage:** Editor spec §Layout "structured property panel … typed
fields (dropdown for type, chip input for tags, etc.)" — covered for the
editable standard keys: `tags` is a chip input (`TagInput`), `resource`/
`timestamp` are typed text inputs, autosave is debounced. Two deliberate,
documented deviations from the spec's literal wording, both grounded in the
backend: (1) `type` is a **read-only display**, not a dropdown, because
`updateNote` forces `type = row.type` — changing type is a note-move operation
belonging to the lifecycle increment, not a frontmatter edit; (2) `timestamp`
is a plain ISO text input, not a native date picker (a deferred enhancement).
Editing/adding/removing *arbitrary extra keys* is out of scope (extra keys are
preserved and shown read-only) — a reasonable first-cut boundary, not a silent
drop.

**Placeholder scan:** no TBD/TODO; every code step is complete and runnable.

**Type consistency:** `TagInput({ value: string[], onChange, disabled? })`
(Task 1) is used exactly that way by `PropertyPanel` (Task 2).
`PropertyPanel({ vaultId, path, initialFrontmatter, readOnly })` (Task 2) is
passed exactly those props by `NoteView` (Task 3). The save payload is the full
frontmatter (`{ ...preserved, resource?, tags?, timestamp? }`), matching the
backend's replace-frontmatter contract and preserving `type` + extra keys.

**Data-safety check (the reason the save sends the whole object):** because
`updateNote` replaces frontmatter with `input.frontmatter`, sending only the
edited keys would silently drop `type` and every extra key. `scheduleSave`
spreads `preserved` (everything except the three editable keys) first, so
`type` and extras always round-trip. The `omits emptied optional keys` and
`preserving type and extra keys` tests lock this in.
