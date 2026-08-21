# UI Slice 2b-6: Inline Markdown Styling (Live-Preview, Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CodeMirror note editor render markdown formatting inline —
headings larger/bolder, `**bold**` bold, `*italic*` italic, `` `code` ``
monospace, links/quotes/strikethrough styled — via a CodeMirror 6
`HighlightStyle`, so a note reads as formatted text while editing.

**Architecture:** Add a markdown `HighlightStyle` (mapping the markdown parser's
highlight tags to **fixed CSS class names** for testability) plus matching style
rules in the editor's `EditorView.theme`, and register it with
`syntaxHighlighting(...)` in the existing `useCodeMirrorEditor` extension list.
No new component, no ViewPlugin.

**Tech Stack:** `@codemirror/language` (`HighlightStyle`, `syntaxHighlighting`),
`@lezer/highlight` (`tags`) — both already in the lockfile as transitive deps of
`@codemirror/lang-markdown`, added here as explicit deps so they're importable.

## Global Constraints

- **Scope — this is Part 1 of live-preview (styling only).** The raw syntax
  markers (`#`, `**`, `` ` ``) remain *visible* (just styled); hiding them "at
  rest" when the cursor isn't on the line (true Obsidian live-preview) is a
  deliberate follow-up increment (2b-7), noted in the docs — not silently
  dropped.
- **Exact dep versions (already resolved in the lockfile — do not bump):**
  `@codemirror/language@6.12.4`, `@lezer/highlight@1.2.3`.
- **Markdown highlight tags actually produced by `@lezer/markdown@1.7.2`**
  (verified): `heading1`–`heading6`, `heading`, `strong`, `emphasis`,
  `strikethrough`, `monospace`, `link`, `url`, `quote`, `list`,
  `processingInstruction` (the markers), `contentSeparator`. Style the
  content tags; leave `processingInstruction` unstyled here (it's what 2b-7 will
  hide).
- **Testability:** use `HighlightStyle.define([{ tag, class: 'cm-md-…' }, …])`
  with FIXED class names (not generated), so tests assert
  `.cm-content .cm-md-h1` etc. exist. Visual sizing/weight lives in the theme,
  keyed on those classes.
- Reuse the existing `EditorView.theme` in `useCodeMirrorEditor` (extend it) and
  the design tokens (`var(--font-mono)`, `var(--primary)`,
  `var(--muted-foreground)`). No invented color literals.
- pnpm; strict TS + `verbatimModuleSyntax`; Vitest explicit imports; happy-dom;
  root `pnpm lint` clean before commit. No `_`-prefixed unused vars.
- Anti-slop tooling (`impeccable`) fires on writes/edits — fix findings before
  the commit.

---

### Task 1: Markdown `HighlightStyle` + theme in `useCodeMirrorEditor`

**Files:**
- Modify: `client/src/hooks/useCodeMirrorEditor.ts`
- Modify: `client/src/hooks/useCodeMirrorEditor.test.tsx`

**Interfaces:** no signature change — `useCodeMirrorEditor` keeps its
`{ doc, onChange, readOnly? }` API; the editor just renders markdown formatting.

- [ ] **Step 1: Install dependencies**

Run:
```bash
cd ~/Documents/chapters/client
pnpm add @codemirror/language@6.12.4 @lezer/highlight@1.2.3
```
(These are already the resolved transitive versions, so the lockfile change is
just promoting them to direct deps of `client`.)

- [ ] **Step 2: Write the failing test**

Add to `client/src/hooks/useCodeMirrorEditor.test.tsx` (inside the existing
`describe('useCodeMirrorEditor', …)`):
```tsx
  it('applies markdown styling classes (heading, strong, emphasis, code)', () => {
    const { getByTestId } = render(
      <Harness doc={'# Title\n\n**bold** and *italic* and `code`'} onChange={vi.fn()} />,
    )
    const container = getByTestId('editor-container')
    expect(container.querySelector('.cm-md-h1')).not.toBeNull()
    expect(container.querySelector('.cm-md-strong')).not.toBeNull()
    expect(container.querySelector('.cm-md-emphasis')).not.toBeNull()
    expect(container.querySelector('.cm-md-code')).not.toBeNull()
  })
```

- [ ] **Step 3: Run it, confirm it fails**

Run: `pnpm -C client test -- useCodeMirrorEditor`
Expected: FAIL — no `.cm-md-*` classes yet (syntax highlighting not registered).

**If this test can't be made to pass** because happy-dom doesn't render CM6's
syntax-highlight decoration spans for the initial doc (a viewport-measurement
limitation similar to the `getClientRects` family): do NOT fake it. Report the
exact symptom in your task report and STOP (BLOCKED) — the controller will
decide whether to adjust the test approach (e.g. assert against
`view.state.facet(...)`/the built highlight spans via the CM API instead of the
DOM). Try the straightforward DOM assertion first; only escalate if it
genuinely can't render.

- [ ] **Step 4: Implement**

Edit `client/src/hooks/useCodeMirrorEditor.ts`. Add imports:
```ts
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
```
Add, above the `useCodeMirrorEditor` function (module scope — it's a constant
extension, built once):
```ts
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-md-h1' },
  { tag: tags.heading2, class: 'cm-md-h2' },
  { tag: tags.heading3, class: 'cm-md-h3' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], class: 'cm-md-h4' },
  { tag: tags.strong, class: 'cm-md-strong' },
  { tag: tags.emphasis, class: 'cm-md-emphasis' },
  { tag: tags.strikethrough, class: 'cm-md-strike' },
  { tag: tags.monospace, class: 'cm-md-code' },
  { tag: [tags.link, tags.url], class: 'cm-md-link' },
  { tag: tags.quote, class: 'cm-md-quote' },
])
```
In the extensions array, add `syntaxHighlighting(markdownHighlight)` immediately
after `markdown(),`. Extend the existing `EditorView.theme({...})` object with
the class rules (keep the existing `&`/`.cm-content`/`.cm-scroller` rules):
```ts
        EditorView.theme({
          '&': { fontFamily: 'var(--font-mono)', fontSize: '14px', height: '100%' },
          '.cm-content': { fontFamily: 'var(--font-mono)' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-md-h1': { fontSize: '1.6em', fontWeight: '700', lineHeight: '1.3' },
          '.cm-md-h2': { fontSize: '1.35em', fontWeight: '700', lineHeight: '1.3' },
          '.cm-md-h3': { fontSize: '1.15em', fontWeight: '700' },
          '.cm-md-h4': { fontWeight: '700' },
          '.cm-md-strong': { fontWeight: '700' },
          '.cm-md-emphasis': { fontStyle: 'italic' },
          '.cm-md-strike': { textDecoration: 'line-through' },
          '.cm-md-code': { fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
          '.cm-md-link': { color: 'var(--primary)', textDecoration: 'underline' },
          '.cm-md-quote': { fontStyle: 'italic', color: 'var(--muted-foreground)' },
        }),
```
(The editor's base font is already monospace; the heading/emphasis rules layer
on top. `.cm-md-code`'s mono is harmless-but-explicit and future-proofs a later
switch to a proportional base font.)

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm -C client test -- useCodeMirrorEditor`
Expected: PASS — all four `.cm-md-*` classes present. Also confirm the two
pre-existing hook tests (`mounts…`, `does not call onChange on mount`) and the
`readOnly` tests still pass.

- [ ] **Step 6: Full suite + typecheck + lint + build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm lint && pnpm -C client build`
Expected: all pass/exit 0.

- [ ] **Step 7: Commit**

```bash
git add client/package.json pnpm-lock.yaml client/src/hooks/useCodeMirrorEditor.ts client/src/hooks/useCodeMirrorEditor.test.tsx
git commit -m "Render markdown formatting inline via a CodeMirror HighlightStyle"
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

Update the editor status copy: the note editor now renders markdown formatting
inline (headings, bold, italic, inline code, links). Note the honest boundary:
the raw syntax markers are still shown; hiding them "at rest" is the remaining
live-preview refinement. Update the two slice-status lines to include Slice 2b-6.

- [ ] **Step 3: Update STATE.md**

Record Slice 2b-6 complete. Name the next increment: 2b-7 — hide markdown syntax
markers at rest (a `ViewPlugin` with `Decoration.replace` that reveals the
markers only on the cursor's line), completing live-preview; then 2c (wikilinks).
Keep the file at or under 40 lines.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/agents/STATE.md
git commit -m "Update README and STATE.md for Slice 2b-6"
```

---

## Self-Review

**Spec coverage:** Editor spec §Layout "the note body, live-preview markdown
(CodeMirror 6): typed markdown syntax renders inline (headers get large,
`**bold**` renders bold)" — the *rendering* half is covered here (headings
sized, bold/italic/code/link/quote styled inline). The clause "rather than
showing raw markdown characters at rest" (marker hiding) is explicitly the next
increment (2b-7), documented — an honest split of a large feature, not a gap.

**Placeholder scan:** no TBD/TODO; Task 1 has complete code. The one conditional
(Step 3's "if happy-dom can't render highlight spans") is a real, named
escalation path with a concrete fallback, not a vague placeholder.

**Type consistency:** `HighlightStyle`/`syntaxHighlighting` from
`@codemirror/language` and `tags` from `@lezer/highlight` are the correct
exports; the `tags.*` names used (`heading1`–`heading6`, `strong`, `emphasis`,
`strikethrough`, `monospace`, `link`, `url`, `quote`) were verified against the
installed `@lezer/markdown@1.7.2`'s actual output, so they will match real nodes.
The fixed class names in `HighlightStyle.define` (`cm-md-h1`…`cm-md-quote`) are
exactly the ones styled in the theme and asserted in the test.
