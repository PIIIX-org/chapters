# UI Slice 2c-2: Clickable Wikilinks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `[[note/path]]` wikilinks as clickable links in the editor;
clicking one (when it's not the line you're editing) navigates to that note.

**Architecture:** A `MatchDecorator`-based `ViewPlugin` (`wikilinkExtension`)
regex-scans the viewport for `[[…]]` (wikilinks aren't in the markdown syntax
tree) and decorates each with a `cm-wikilink` class + `data-wikilink-target`
attribute; a paired `mousedown` DOM handler navigates via an injected callback
when the clicked link is on a "rendered" (non-cursor) line. Wired into
`useCodeMirrorEditor` via a new `onWikilinkClick` option; `NoteView` passes a
`useNavigate` handler.

**Tech Stack:** `@codemirror/view` (`MatchDecorator`, `ViewPlugin`,
`Decoration`, `EditorView.domEventHandlers`, `posAtDOM`) — all already direct
deps. No new dependency. React Router `useNavigate`.

## Global Constraints

- **Scope — clickable navigation to EXISTING notes only.** Clicking a wikilink
  to a *missing* note currently navigates to the note route (which shows "Note
  not found"); intercepting missing-note clicks to **create** the note
  (link-to-create) is the next increment (2c-3), documented — not this one.
- **Wikilink regex** (matches the backend's `extractWikilinks`, `okf.ts`):
  `/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g` — capture group 1 (trimmed) is the note
  **path** target.
- **Click semantics (live-preview-friendly):** a left-click on a wikilink whose
  line the selection does NOT currently touch navigates (the link is
  "rendered"); a click on a wikilink on the line the cursor is already on falls
  through to normal cursor placement (so the source stays editable). This reuses
  the same active-line notion as marker-hiding.
- pnpm; strict TS + `verbatimModuleSyntax` (type-only imports use `import type`);
  Vitest explicit imports; happy-dom; existing design tokens (`var(--primary)`);
  no new deps. Root `pnpm lint` clean before each commit. No `_`-prefixed unused
  vars.
- Anti-slop tooling (`impeccable`) fires on writes/edits — fix findings first.

---

### Task 1: `wikilinkExtension` (decoration + click handler)

**Files:**
- Create: `client/src/hooks/wikilinkDecorations.ts`
- Create: `client/src/hooks/wikilinkDecorations.test.tsx`

**Interfaces:**
- Produces: `wikilinkExtension(onClick: (target: string) => void): Extension` —
  a CodeMirror extension array: a `ViewPlugin` decorating `[[…]]` matches with
  `class="cm-wikilink" data-wikilink-target="<path>"`, plus a `mousedown`
  handler that calls `onClick(target)` (and prevents default) when a wikilink on
  a non-cursor line is left-clicked. Task 2 consumes it.

- [ ] **Step 1: Write the failing tests**

`client/src/hooks/wikilinkDecorations.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { wikilinkExtension } from './wikilinkDecorations'

// Minimal harness: mount a plain EditorView with just the wikilink extension.
function Editor({ doc, onClick }: { doc: string; onClick: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [wikilinkExtension(onClick)] }),
      parent: ref.current!,
    })
    return () => view.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div ref={ref} data-testid="ed" />
}

describe('wikilinkExtension', () => {
  it('decorates a [[path]] with the wikilink class + target attribute', () => {
    const { getByTestId } = render(<Editor doc="see [[people/jane]] here" onClick={vi.fn()} />)
    const link = getByTestId('ed').querySelector('.cm-wikilink')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('data-wikilink-target')).toBe('people/jane')
  })

  it('navigates (calls onClick) when a wikilink on a non-cursor line is clicked', () => {
    const onClick = vi.fn()
    // cursor defaults to offset 0 (line 1); the wikilink is on line 3.
    const { getByTestId } = render(<Editor doc={'line one\n\n[[people/jane]]'} onClick={onClick} />)
    const link = getByTestId('ed').querySelector('.cm-wikilink') as HTMLElement
    fireEvent.mouseDown(link, { button: 0 })
    expect(onClick).toHaveBeenCalledWith('people/jane')
  })

  it('does NOT navigate when the wikilink is on the cursor line (edit mode)', () => {
    const onClick = vi.fn()
    // cursor at 0 = line 1, where the wikilink also is → editing, not navigating.
    const { getByTestId } = render(<Editor doc={'[[people/jane]] rest'} onClick={onClick} />)
    const link = getByTestId('ed').querySelector('.cm-wikilink') as HTMLElement
    fireEvent.mouseDown(link, { button: 0 })
    expect(onClick).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `pnpm -C client test -- wikilinkDecorations`
Expected: FAIL — `./wikilinkDecorations` doesn't exist yet.

**Empirical-risk note (read before Step 4):** the two click tests rely on
happy-dom delivering a `fireEvent.mouseDown` on the decoration span up to
CodeMirror's `domEventHandlers` listener, and on `view.posAtDOM(el)` resolving
the span's position. This is expected to work (decoration spans render under
happy-dom — confirmed in 2b-6/2b-7), but is not guaranteed. Try it as written
FIRST. If the click genuinely can't be delivered/handled under happy-dom despite
a correct implementation, do NOT fake it: report DONE_WITH_CONCERNS/BLOCKED with
the exact symptom so the controller can decide (e.g. test the handler's
line-logic more directly). The *decoration* test (test 1) must pass regardless.

- [ ] **Step 3: Implement**

`client/src/hooks/wikilinkDecorations.ts`:
```ts
import { Decoration, EditorView, MatchDecorator, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

const matcher = new MatchDecorator({
  regexp: /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g,
  decoration: (match) =>
    Decoration.mark({
      class: 'cm-wikilink',
      attributes: { 'data-wikilink-target': match[1]!.trim() },
    }),
})

const wikilinkView = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = matcher.createDeco(view)
    }
    update(update: ViewUpdate) {
      this.decorations = matcher.updateDeco(update, this.decorations)
    }
  },
  { decorations: (v) => v.decorations },
)

function clickHandler(onClick: (target: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (event.button !== 0) return false
      const el = (event.target as HTMLElement | null)?.closest('.cm-wikilink') as HTMLElement | null
      if (!el) return false
      const target = el.getAttribute('data-wikilink-target')
      if (!target) return false
      // On the line the cursor already occupies → let the click place the
      // cursor (edit the source). Otherwise the link is "rendered" → navigate.
      const line = view.state.doc.lineAt(view.posAtDOM(el))
      const editing = view.state.selection.ranges.some((r) => {
        const from = view.state.doc.lineAt(r.from).from
        const to = view.state.doc.lineAt(r.to).to
        return line.from >= from && line.to <= to
      })
      if (editing) return false
      event.preventDefault()
      onClick(target)
      return true
    },
  })
}

export function wikilinkExtension(onClick: (target: string) => void): Extension {
  return [wikilinkView, clickHandler(onClick)]
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm -C client test -- wikilinkDecorations && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/wikilinkDecorations.ts client/src/hooks/wikilinkDecorations.test.tsx
git commit -m "Add wikilinkExtension (clickable [[link]] decoration + navigate)"
```

---

### Task 2: Wire clickable wikilinks into the editor via `NoteView`

**Files:**
- Modify: `client/src/hooks/useCodeMirrorEditor.ts`
- Modify: `client/src/hooks/useCodeMirrorEditor.test.tsx`
- Modify: `client/src/pages/vault/NoteView.tsx`

**Interfaces:**
- Consumes: `wikilinkExtension` (Task 1).
- Produces: `useCodeMirrorEditor` gains `onWikilinkClick?: (target: string) => void`;
  when set, registers `wikilinkExtension(onWikilinkClick)` and styles
  `.cm-wikilink`. `NoteView` passes a handler navigating to the target note.

- [ ] **Step 1: Add the option + styling to `useCodeMirrorEditor`**

In `client/src/hooks/useCodeMirrorEditor.ts`:
- import: `import { wikilinkExtension } from './wikilinkDecorations.js'`
- extend the options interface + destructure:
  ```ts
  interface UseCodeMirrorEditorOptions {
    doc: string
    onChange: (doc: string) => void
    readOnly?: boolean
    wikilinkTargets?: string[]
    onWikilinkClick?: (target: string) => void
  }
  ```
  ```ts
  export function useCodeMirrorEditor({ doc, onChange, readOnly = false, wikilinkTargets = [], onWikilinkClick }: UseCodeMirrorEditorOptions) {
  ```
- capture `onWikilinkClick` in a ref (like `onChange`), so the handler stays
  fresh without re-mounting:
  ```ts
  const onWikilinkClickRef = useRef(onWikilinkClick)
  useEffect(() => {
    onWikilinkClickRef.current = onWikilinkClick
  })
  ```
- in the extensions array, add (after `autocompletion(...)`):
  ```ts
        wikilinkExtension((target) => onWikilinkClickRef.current?.(target)),
  ```
- add a `.cm-wikilink` rule to the existing `EditorView.theme({...})`:
  ```ts
          '.cm-wikilink': { color: 'var(--primary)', textDecoration: 'underline', cursor: 'pointer' },
  ```

- [ ] **Step 2: Add a hook smoke test**

Add to `client/src/hooks/useCodeMirrorEditor.test.tsx` (extend `Harness` to
accept + forward `onWikilinkClick`), asserting the editor still mounts and a
wikilink is decorated:
```tsx
  it('decorates wikilinks when onWikilinkClick is provided', () => {
    const { getByTestId } = render(
      <Harness doc={'see [[people/jane]]'} onChange={vi.fn()} onWikilinkClick={vi.fn()} />,
    )
    expect(getByTestId('editor-container').querySelector('.cm-wikilink')).not.toBeNull()
  })
```

- [ ] **Step 3: Run, confirm the new test passes**

Run: `pnpm -C client test -- useCodeMirrorEditor`
Expected: PASS (all pre-existing hook tests + the new one).

- [ ] **Step 4: Wire `NoteView` to navigate**

In `client/src/pages/vault/NoteView.tsx`:
- import `useNavigate` from `react-router` (add to the existing `react-router`
  import).
- inside `NoteEditor`, get `const navigate = useNavigate()` and pass the handler
  to the hook:
  ```ts
  const editorRef = useCodeMirrorEditor({
    doc: initialBody,
    onChange: handleChange,
    readOnly,
    wikilinkTargets,
    onWikilinkClick: (target) => navigate(`/vaults/${vaultId}/notes/${target}`),
  })
  ```
  (Leave the rest of `NoteEditor` unchanged.)

- [ ] **Step 5: Run the NoteView tests**

The NoteView tests already render inside a router (`createMemoryRouter`), so
`useNavigate` resolves. Run `pnpm -C client test -- NoteView` and confirm they
still pass unchanged (no wikilinks in their fixtures → no navigation fires).

- [ ] **Step 6: Full suite + typecheck + lint + build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm lint && pnpm -C client build`
Expected: all pass/exit 0.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/useCodeMirrorEditor.ts client/src/hooks/useCodeMirrorEditor.test.tsx client/src/pages/vault/NoteView.tsx
git commit -m "Wire clickable wikilink navigation into the note editor"
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

Update the wikilink status copy: `[[links]]` are now clickable and navigate to
the note (clicking a link on a line you're not editing). Note the boundary:
clicking a link to a *missing* note (link-to-create) is the next increment.
Update the slice-status lines to add Slice 2c-2.

- [ ] **Step 3: Update STATE.md**

Record Slice 2c-2 complete; name the next increment (2c-3: link-to-create —
clicking a wikilink to a note that doesn't exist creates it type-first). Keep
the file at or under 40 lines.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/agents/STATE.md
git commit -m "Update README and STATE.md for Slice 2c-2"
```

---

## Self-Review

**Spec coverage:** Editor spec §Wikilinks bullet 2 — "A rendered `[[link]]` in
live-preview mode is clickable and navigates to that note" — is covered:
wikilinks are decorated as links and a click on a rendered (non-cursor-line)
wikilink navigates. Bullet 3 (link-to-create for a missing note) is explicitly
the next increment (2c-3), documented, not dropped.

**Placeholder scan:** no TBD/TODO; Tasks 1–2 have complete code. Step 2's
empirical-risk note is a real, named escalation path (not a placeholder).

**Type consistency:** `wikilinkExtension(onClick: (target: string) => void):
Extension` (Task 1) is used exactly that way in `useCodeMirrorEditor` (Task 2),
which threads `onWikilinkClick` through a ref so the handler stays fresh without
remounting. `NoteView` supplies the handler via `useNavigate`, navigating to
`/vaults/${vaultId}/notes/${target}` — the same route format `FileTree` links
use, and `target` is the note path (matching the wikilink target format and the
backend's resolution key).
