# UI Slice 3b: Search overlay keyboard navigation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a keyboard-only user drive the ⌘K search overlay — ↑/↓ to move a highlighted selection through the results and Enter to open it — and make the overlay a proper accessible modal dialog.

**Architecture:** Extend the existing `SearchOverlay` component (from Slice 3a). Focus stays in the search `Input`; arrow keys move a virtual `active` index over the `notes` array (the ARIA combobox + listbox pattern, `aria-activedescendant`), Enter opens the active row. Add `role="dialog"`/`aria-modal` to the panel and return focus to the trigger on close. No new files, no new dependencies.

**Tech Stack:** React 19, TanStack Query v5, react-router, Tailwind (existing design tokens), Vitest + Testing Library.

## Global Constraints

- No new npm dependencies — reuse existing `Input`, hooks, and design tokens.
- Design tokens only: active row uses `bg-muted` (same as hover); teal `bg-accent` is reserved for AI-authored content, do not use it here.
- TDD: failing test first, minimal code, green, commit — every task.
- Keyboard handling lives in the `Input`'s existing `onKeyDown` (the input holds focus); do NOT add a second global `window` keydown listener — `GlobalSearch` owns the only one (⌘K open).
- Preserve all Slice 3a behavior: 250ms debounce, note-only results, click-to-navigate, Escape + backdrop close, query disabled while closed.
- `client/` root: `pnpm -C client test` (Vitest), `pnpm typecheck`, `pnpm lint`, `pnpm -C client build` must all stay green.

---

### Task 1: Arrow-key selection + Enter to open

**Files:**
- Modify: `client/src/components/search/SearchOverlay.tsx`
- Test: `client/src/components/search/SearchOverlay.test.tsx`

**Interfaces:**
- Consumes (already in the component): `notes: SearchResult[]` (filtered to `resourceType === 'note'`), `go(containerId, path)`, `debounced`, `results`, the `Input`'s `onKeyDown`.
- Produces: an `active` selection index; the active row carries `aria-selected` and drives `Enter`. No new exports.

- [ ] **Step 1: Write the failing tests**

Add these to `SearchOverlay.test.tsx`. `scrollIntoView` is not implemented in jsdom, so stub it once at the top of the file (inside the existing `describe`, before the tests, add a `beforeEach`):

```tsx
import { beforeEach } from 'vitest'
// ...inside describe('SearchOverlay', () => { ... }) add:
beforeEach(() => {
  // jsdom does not implement scrollIntoView; the active-row auto-scroll calls it.
  Element.prototype.scrollIntoView = vi.fn()
})
```

Then the new tests (they reuse the same two-result fetch mock as the existing debounce test — factor a small helper or inline it):

```tsx
it('ArrowDown/ArrowUp move the highlighted row and Enter opens it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const fetchMock = vi.fn().mockResolvedValue(
    mockJsonResponse(200, [
      { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'people/jane', snippet: 'a', score: 1 },
      { resourceType: 'note', id: 'n2', containerId: 'v2', path: 'people/john', snippet: 'b', score: 0.9 },
    ]),
  )
  vi.stubGlobal('fetch', fetchMock)
  const { onClose, router } = renderOverlay(true)

  fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'p' } })
  await vi.advanceTimersByTimeAsync(300)
  await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

  const input = screen.getByPlaceholderText(/search/i)
  const options = () => screen.getAllByRole('option')

  // First row selected by default.
  expect(options()[0]).toHaveAttribute('aria-selected', 'true')

  // ArrowDown -> second row selected.
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  expect(options()[1]).toHaveAttribute('aria-selected', 'true')
  expect(options()[0]).toHaveAttribute('aria-selected', 'false')

  // ArrowDown at the end clamps (stays on last).
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  expect(options()[1]).toHaveAttribute('aria-selected', 'true')

  // Enter opens the active (second) row and closes.
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(router.state.location.pathname).toBe('/vaults/v2/notes/people/john')
  expect(onClose).toHaveBeenCalled()
})

it('ArrowUp clamps at the first row', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    mockJsonResponse(200, [
      { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'a', snippet: 'x', score: 1 },
      { resourceType: 'note', id: 'n2', containerId: 'v2', path: 'b', snippet: 'y', score: 0.9 },
    ]),
  ))
  renderOverlay(true)
  fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'p' } })
  await vi.advanceTimersByTimeAsync(300)
  await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument())

  const input = screen.getByPlaceholderText(/search/i)
  fireEvent.keyDown(input, { key: 'ArrowUp' }) // already at 0 -> stays
  expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
})

it('resets selection to the first row when the query changes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    mockJsonResponse(200, [
      { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'a', snippet: 'x', score: 1 },
      { resourceType: 'note', id: 'n2', containerId: 'v2', path: 'b', snippet: 'y', score: 0.9 },
    ]),
  ))
  renderOverlay(true)
  const input = screen.getByPlaceholderText(/search/i)
  fireEvent.change(input, { target: { value: 'p' } })
  await vi.advanceTimersByTimeAsync(300)
  await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument())

  fireEvent.keyDown(input, { key: 'ArrowDown' }) // select row 2
  expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')

  fireEvent.change(input, { target: { value: 'pq' } }) // new query
  await vi.advanceTimersByTimeAsync(300)
  await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true'))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C client test SearchOverlay`
Expected: FAIL — no elements with `role="option"`, ArrowDown/Enter do nothing.

- [ ] **Step 3: Implement selection state + key handling**

In `SearchOverlay.tsx`:

Add `useRef` to the React import and `active` state + a reset effect + a clamped index. After the existing `debounced` state and its effect:

```tsx
const [active, setActive] = useState(0)
// New query -> results change -> restart selection at the top.
useEffect(() => setActive(0), [debounced])
```

After `const notes = ...`:

```tsx
const activeIndex = notes.length ? Math.min(active, notes.length - 1) : 0
const activeRef = useRef<HTMLLIElement>(null)
useEffect(() => {
  activeRef.current?.scrollIntoView({ block: 'nearest' })
}, [activeIndex])
```

Replace the existing `onKeyDown` with arrow + Enter handling (keep Escape):

```tsx
function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    onClose()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    setActive((i) => Math.min(i + 1, notes.length - 1))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    setActive((i) => Math.max(i - 1, 0))
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const r = notes[activeIndex]
    if (r) go(r.containerId, r.path)
  }
}
```

Update the list markup to expose selection. Give the `<ul>` `role="listbox"` and each row `role="option"` + `aria-selected`, highlight the active row, and attach the scroll ref:

```tsx
<ul role="listbox" className="max-h-[50vh] overflow-auto">
  {notes.map((r, i) => (
    <li
      key={`${r.resourceType}:${r.id}`}
      ref={i === activeIndex ? activeRef : undefined}
      role="option"
      aria-selected={i === activeIndex}
    >
      <button
        type="button"
        onClick={() => go(r.containerId, r.path)}
        onMouseMove={() => setActive(i)}
        className={`block w-full px-4 py-2 text-left ${i === activeIndex ? 'bg-muted' : ''}`}
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
```

Note: the row's `hover:bg-muted` is dropped in favor of `onMouseMove={() => setActive(i)}`, so mouse and keyboard share one highlight (moving the mouse selects the row, which then shows `bg-muted`). This keeps a single source of truth for "which row is active."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C client test SearchOverlay`
Expected: PASS — all SearchOverlay tests green (new + existing).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/search/SearchOverlay.tsx client/src/components/search/SearchOverlay.test.tsx
git commit -m "Add arrow-key selection + Enter to the search overlay"
```

---

### Task 2: Dialog a11y + focus return, verification & docs

**Files:**
- Modify: `client/src/components/search/SearchOverlay.tsx`
- Test: `client/src/components/search/SearchOverlay.test.tsx`
- Modify: `README.md`, `docs/agents/STATE.md`

**Interfaces:**
- Consumes: the `open`/`onClose` props and the `active`/`activeIndex` state from Task 1.
- Produces: `role="dialog"` panel with `aria-modal`; input wired as a combobox (`aria-activedescendant`); focus returns to the trigger on close.

- [ ] **Step 1: Write the failing tests**

```tsx
it('exposes the panel as an accessible modal dialog', () => {
  renderOverlay(true)
  const dialog = screen.getByRole('dialog')
  expect(dialog).toHaveAttribute('aria-modal', 'true')
  expect(dialog).toHaveAccessibleName(/search/i)
})

it('returns focus to the previously focused element when it closes', () => {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  expect(document.activeElement).toBe(trigger)

  const { rerender } = renderOverlayControlled(true)
  // input autofocuses while open
  expect(document.activeElement).toBe(screen.getByPlaceholderText(/search/i))

  rerender(false)
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})
```

`renderOverlayControlled` is a small helper that renders `SearchOverlay` with a controllable `open` prop so the test can toggle it (the existing `renderOverlay` fixes `open`). Add near the top of the test file:

```tsx
function renderOverlayControlled(initialOpen: boolean) {
  const onClose = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Harness({ open }: { open: boolean }) {
    const router = createMemoryRouter(
      [{ path: '/', element: <SearchOverlay open={open} onClose={onClose} /> }],
      { initialEntries: ['/'] },
    )
    return (
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    )
  }
  const view = render(<Harness open={initialOpen} />)
  return { onClose, rerender: (open: boolean) => view.rerender(<Harness open={open} />) }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C client test SearchOverlay`
Expected: FAIL — no `role="dialog"`; focus not restored on close.

- [ ] **Step 3: Implement dialog roles + focus return**

In `SearchOverlay.tsx`:

Add a focus-restore effect (near the other effects, before the `if (!open) return null`):

```tsx
const restoreRef = useRef<HTMLElement | null>(null)
useEffect(() => {
  if (open) {
    restoreRef.current = document.activeElement as HTMLElement
  } else {
    restoreRef.current?.focus?.()
  }
}, [open])
```

Add `role="dialog" aria-modal="true" aria-label="Search"` to the inner panel `<div>`:

```tsx
<div
  role="dialog"
  aria-modal="true"
  aria-label="Search"
  className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-background shadow-lg"
>
```

Wire the input as a combobox pointing at the active option. Give each option a stable id and set `aria-activedescendant` on the `Input`:

- Add `id={`search-opt-${i}`}` to each `<li role="option">`.
- On the `Input`, add:
  ```tsx
  role="combobox"
  aria-expanded={notes.length > 0}
  aria-controls="search-listbox"
  aria-activedescendant={notes.length ? `search-opt-${activeIndex}` : undefined}
  ```
- Add `id="search-listbox"` to the `<ul role="listbox">`.

- [ ] **Step 4: Run the full client suite + verification**

Run:
```bash
pnpm -C client test
pnpm typecheck
pnpm lint
pnpm -C client build
```
Expected: all green.

- [ ] **Step 5: Update docs**

- `README.md`: in the search sentence, note keyboard use — e.g. append "Arrow keys move the selection and Enter opens it."
- `docs/agents/STATE.md`: move Slice 3b from "Next step" to done under Slice 3; set next step to Slice 4 (Team page). Keep the file ≤40 lines.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/search/SearchOverlay.tsx client/src/components/search/SearchOverlay.test.tsx README.md docs/agents/STATE.md
git commit -m "Make the search overlay an accessible modal + return focus on close"
```

---

## Self-Review

**Spec coverage:** 3b's scope = keyboard nav (↑/↓/Enter) + the modal a11y the 3a review deferred. Task 1 covers arrow/Enter selection + listbox/option roles + auto-scroll; Task 2 covers dialog role/aria-modal + focus return + combobox `aria-activedescendant`. Both covered.

**Placeholders:** none — every code step is concrete.

**Type consistency:** `active`/`activeIndex`/`notes`/`go` names are consistent across both tasks; `SearchResult` shape matches Slice 3a's `api/search.ts`.

**Deferred (ponytail):** no full Tab focus-trap — the panel's only tabbables are the input and result buttons, arrow keys drive selection, `aria-modal` signals modality, and focus returns to the trigger on close. Add a Tab-cycle trap only if a later slice adds more focusables to the overlay.
