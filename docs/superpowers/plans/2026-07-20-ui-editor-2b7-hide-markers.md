# UI Slice 2b-7: Hide Markdown Markers At Rest (Live-Preview, Part 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete live-preview: hide the raw markdown syntax markers
(`#`, `**`/`*`, `` ` ``) when the cursor is not on their line, and reveal them
again when the cursor moves onto that line — so a note reads as rendered prose
at rest and as editable source where you're working.

**Architecture:** A CodeMirror 6 `ViewPlugin` (`markdownMarkerHiding`, its own
module) that builds a `Decoration.replace` set over marker nodes from the
markdown syntax tree, skipping any marker on a line the selection touches, and
rebuilds on document or selection change. Registered in the existing
`useCodeMirrorEditor` extension list, after the 2b-6 `syntaxHighlighting`.

**Tech Stack:** `@codemirror/view` (`ViewPlugin`, `Decoration`),
`@codemirror/state` (`RangeSetBuilder`), `@codemirror/language` (`syntaxTree`) —
all already direct deps. No new dependency.

## Global Constraints

- **Builds on 2b-6** (merged): markdown formatting already renders inline via a
  `HighlightStyle`. This increment only *hides the markers*; it does not change
  the styling.
- **Marker node names** (verified from `@lezer/markdown@1.7.2`): hide
  `HeaderMark`, `EmphasisMark`, `CodeMark`, `StrikethroughMark`. **Keep visible**
  (out of scope this increment): `ListMark` (list bullets — Obsidian keeps
  them), `QuoteMark`, `LinkMark`. `StrikethroughMark` only appears with GFM
  (not enabled by default) — including it in the set is harmless if absent.
- **Reveal rule:** a marker is *shown* if its range lies within a line the
  current selection touches (`doc.lineAt(range.from)`..`doc.lineAt(range.to)`
  for each selection range); otherwise it's replaced (hidden). Rebuild the
  decorations on `docChanged || selectionSet`.
- **Heading marker:** hide the `HeaderMark` **plus the single following space**
  (so `# Heading` renders as `Heading`, not ` Heading`).
- Works uniformly for editable and read-only views (the plugin is unconditional).
  Known cosmetic edge (carry, don't fix here): a read-only view's default
  selection sits at offset 0, so the first line's markers show even at rest.
- pnpm; strict TS + `verbatimModuleSyntax` (type-only imports use `import type`);
  Vitest explicit imports; happy-dom; existing design — no new deps, no invented
  styles. Root `pnpm lint` clean before each commit. No `_`-prefixed unused vars.
- Anti-slop tooling (`impeccable`) fires on writes/edits — fix findings first.

---

### Task 1: `markdownMarkerHiding` ViewPlugin + integration

**Files:**
- Create: `client/src/hooks/markdownMarkerHiding.ts`
- Modify: `client/src/hooks/useCodeMirrorEditor.ts`
- Modify: `client/src/hooks/useCodeMirrorEditor.test.tsx`

**Interfaces:**
- Produces: `export const markdownMarkerHiding` — a CodeMirror `Extension`
  (a `ViewPlugin` providing a decoration set). `useCodeMirrorEditor` adds it to
  its extension list; no signature change to the hook.

- [ ] **Step 1: Write the failing tests**

Add to `client/src/hooks/useCodeMirrorEditor.test.tsx` (inside the existing
`describe`). These drive the whole feature through the real hook:
```tsx
  it('shows the heading marker when the cursor is on that line', () => {
    render(<Harness doc={'# Heading\n\nbody'} onChange={vi.fn()} />)
    // Default selection is at offset 0 → line 1 is active → marker visible.
    const firstLine = document.querySelector('.cm-line')
    expect(firstLine?.textContent).toBe('# Heading')
  })

  it('hides the heading marker when the cursor is on another line', async () => {
    render(<Harness doc={'# Heading\n\nbody'} onChange={vi.fn()} />)
    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
    // Move the cursor to the end (the "body" line) — line 1 is no longer active.
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    const firstLine = document.querySelector('.cm-line')
    expect(firstLine?.textContent).toBe('Heading')
  })

  it('hides inline emphasis/code markers on an inactive line', async () => {
    render(<Harness doc={'top\n\n**bold** and `code`'} onChange={vi.fn()} />)
    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
    // Cursor on line 1 ("top"); the emphasis/code line is inactive.
    view.dispatch({ selection: { anchor: 0 } })
    const lines = document.querySelectorAll('.cm-line')
    const last = lines[lines.length - 1]
    expect(last?.textContent).toBe('bold and code')
  })
```

Note the `Harness` (from earlier tasks) renders `useCodeMirrorEditor({ doc,
onChange })` on a container. The tests use the real editor DOM.

- [ ] **Step 2: Run, confirm the new tests fail**

Run: `pnpm -C client test -- useCodeMirrorEditor`
Expected: the two "hides…" tests FAIL — with no marker-hiding, `# Heading`
renders as `# Heading` and `**bold** and \`code\`` renders with markers. (The
"shows…" test may already pass since markers are always shown today.)

**Empirical-risk escalation (read before Step 4):** these tests assume happy-dom
reflects a `Decoration.replace` in the rendered `.cm-line` `textContent` after a
`selectionSet`-triggered decoration rebuild. This is expected (2b-6 confirmed
happy-dom renders CM6 decoration spans), but is not guaranteed for *replace*
decorations. If after a correct implementation the hidden text still appears in
`textContent`, do NOT fake it: report DONE_WITH_CONCERNS/BLOCKED with the exact
observed DOM, so the controller can switch to asserting via the decoration set
directly (e.g. inspect the plugin's `decorations` ranges through the CM API)
instead of `textContent`.

- [ ] **Step 3: Implement the ViewPlugin**

`client/src/hooks/markdownMarkerHiding.ts`:
```ts
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

// Punctuation markers hidden at rest and revealed on the cursor's line.
const HIDDEN_MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark'])
const hidden = Decoration.replace({})

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  // Line spans the selection touches — markers on these stay visible for editing.
  const active = state.selection.ranges.map((r) => {
    const from = state.doc.lineAt(r.from).from
    const to = state.doc.lineAt(r.to).to
    return [from, to] as const
  })
  const onActiveLine = (from: number, to: number) =>
    active.some(([lo, hi]) => from >= lo && to <= hi)

  const builder = new RangeSetBuilder<Decoration>()
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.to <= node.from) return
      if (!HIDDEN_MARKS.has(node.name)) return
      if (onActiveLine(node.from, node.to)) return
      // Hide the heading '#' plus its trailing space so '# H' renders as 'H'.
      let to = node.to
      if (node.name === 'HeaderMark' && state.doc.sliceString(to, to + 1) === ' ') to += 1
      builder.add(node.from, to, hidden)
    },
  })
  return builder.finish()
}

export const markdownMarkerHiding = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)
```

- [ ] **Step 4: Integrate into `useCodeMirrorEditor`**

In `client/src/hooks/useCodeMirrorEditor.ts`, add the import:
```ts
import { markdownMarkerHiding } from './markdownMarkerHiding.js'
```
and add `markdownMarkerHiding` to the `extensions` array, immediately after the
`syntaxHighlighting(markdownHighlight)` line (so it layers on top of the 2b-6
styling). Leave everything else unchanged.

- [ ] **Step 5: Run the tests, verify they pass**

Run: `pnpm -C client test -- useCodeMirrorEditor`
Expected: PASS — all marker-hiding tests green, AND the pre-existing tests
(mount, no-onChange-on-mount, readOnly, the 2b-6 `.cm-md-*` styling test) still
pass (hiding a marker doesn't remove the styled *content*, only the punctuation).

- [ ] **Step 6: Full suite + typecheck + lint + build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm lint && pnpm -C client build`
Expected: all pass/exit 0.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/markdownMarkerHiding.ts client/src/hooks/useCodeMirrorEditor.ts client/src/hooks/useCodeMirrorEditor.test.tsx
git commit -m "Hide markdown syntax markers at rest, reveal on the cursor's line"
```

---

### Task 2: Final verification + docs

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

Update the editor status copy: live-preview is now complete — the editor hides
the raw markdown markers at rest and reveals them on the cursor's line. Update
the two slice-status lines: Slice 2b-7 done; the Editor (Slice 2b) is complete;
next is Slice 2c (wikilinks).

- [ ] **Step 3: Update STATE.md**

Record Slice 2b-7 complete and the Editor (2b) finished. Name the next
increment: Slice 2c — wikilinks (`[[` typeahead against vault notes, clickable
rendered links, link-to-create). Keep the file at or under 40 lines.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/agents/STATE.md
git commit -m "Update README and STATE.md for Slice 2b-7"
```

---

## Self-Review

**Spec coverage:** Editor spec §Layout "typed markdown syntax renders inline …
rather than showing raw markdown characters at rest" — the "at rest" clause is
now covered: markers hide when the cursor is elsewhere and reveal on the active
line, completing the live-preview requirement started in 2b-6. `ListMark`/
`QuoteMark`/`LinkMark` staying visible is a deliberate, documented scope
boundary (list bullets are conventionally kept; link/quote rendering is heavier
and can follow), not a silent gap.

**Placeholder scan:** no TBD/TODO; Task 1 has complete code. The one conditional
(Step 2's happy-dom escalation) is a real, named path with a concrete fallback.

**Type consistency:** `markdownMarkerHiding` is an `Extension` (a `ViewPlugin`);
`useCodeMirrorEditor` adds it to its `extensions` array, which already holds
`ViewPlugin`/extension values (`syntaxHighlighting`, `EditorView.updateListener`,
etc.), so it composes without a type change. `syntaxTree`/`RangeSetBuilder`/
`Decoration`/`ViewPlugin`/`EditorView` are the correct exports from
`@codemirror/language`/`@codemirror/state`/`@codemirror/view` respectively. The
`HIDDEN_MARKS` node names match `@lezer/markdown`'s actual node types.
