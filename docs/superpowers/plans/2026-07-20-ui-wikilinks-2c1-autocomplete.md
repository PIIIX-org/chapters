# UI Slice 2c-1: Wikilink Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user types `[[` in the note editor, offer an autocomplete
dropdown of the current vault's note paths, so wikilinks are written against
real, correctly-spelled targets.

**Architecture:** A pure CodeMirror `CompletionSource` (`wikilinkCompletions`)
that fires inside an open `[[…` and suggests supplied note paths; wired into
`useCodeMirrorEditor` via a new `wikilinkTargets` option that registers
`@codemirror/autocomplete`'s `autocompletion` with that source. `NoteView`
supplies the paths from the already-cached vault tree.

**Tech Stack:** `@codemirror/autocomplete@6.20.3` (`autocompletion`,
`CompletionContext`, `CompletionSource`) — already in the lockfile as a
transitive dep, added here as a direct dep. Reuses `useVaultTree` (Slice 2a).

## Global Constraints

- **Wikilink target format = note `path`** (`type/name`). Verified from the
  backend: the graph resolves `[[targetPath]]` via
  `noteByVaultPath.get(`${vaultId}:${targetPath}`)` (`server/src/graph/assemble.ts`)
  — so the string inside `[[…]]` is the note's path. Autocomplete suggests
  note paths, and applying a completion inserts `path]]`.
- **Scope — autocomplete only (2c-1).** Clickable rendered wikilinks and
  link-to-create are the next increment (2c-2), documented — not this one.
- `@codemirror/autocomplete@6.20.3` (exact, already the resolved transitive
  version — promote to direct dep, no bump).
- The completion source is a pure function of `(targets, CompletionContext)` —
  unit-testable without the autocomplete UI (which is hard to drive under
  happy-dom). The editor-integration tests only assert the editor still mounts
  and behaves; the *logic* is covered by the source's unit test.
- pnpm; strict TS + `verbatimModuleSyntax` (type-only imports use `import type`);
  Vitest explicit imports; happy-dom; existing design — no invented styles.
  Root `pnpm lint` clean before each commit. No `_`-prefixed unused vars.
- Anti-slop tooling (`impeccable`) fires on writes/edits — fix findings first.

---

### Task 1: `wikilinkCompletions` source

**Files:**
- Create: `client/src/hooks/wikilinkCompletions.ts`
- Create: `client/src/hooks/wikilinkCompletions.test.ts`

**Interfaces:**
- Produces: `wikilinkCompletions(targets: string[]): CompletionSource` — a
  CodeMirror completion source. Returns a `CompletionResult` (with `from` set to
  just after the `[[`, and one option per target applying `path]]`) when the
  cursor sits inside an open `[[…`, and `null` otherwise. Task 2 consumes it.

- [ ] **Step 1: Install the dependency**

Run:
```bash
cd ~/Documents/chapters/client
pnpm add @codemirror/autocomplete@6.20.3
```

- [ ] **Step 2: Write the failing test**

`client/src/hooks/wikilinkCompletions.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { wikilinkCompletions } from './wikilinkCompletions'

function resultFor(doc: string, pos: number, targets: string[]) {
  const state = EditorState.create({ doc })
  return wikilinkCompletions(targets)(new CompletionContext(state, pos, false))
}

describe('wikilinkCompletions', () => {
  const targets = ['people/jane', 'projects/roadmap']

  it('suggests note paths inside an open [[', () => {
    const result = resultFor('[[pe', 4, targets)
    expect(result).not.toBeNull()
    expect(result!.from).toBe(2) // just after the [[
    expect(result!.options.map((o) => o.label)).toEqual(targets)
    expect(result!.options[0]!.apply).toBe('people/jane]]')
  })

  it('returns null when the cursor is not inside a wikilink', () => {
    expect(resultFor('hello world', 11, targets)).toBeNull()
  })

  it('returns null once the wikilink is closed', () => {
    // cursor after the closing ]] — matchBefore no longer sees an open [[
    expect(resultFor('[[people/jane]]', 15, targets)).toBeNull()
  })
})
```

- [ ] **Step 3: Run, confirm fail**

Run: `pnpm -C client test -- wikilinkCompletions`
Expected: FAIL — `./wikilinkCompletions` doesn't exist yet.

- [ ] **Step 4: Implement**

`client/src/hooks/wikilinkCompletions.ts`:
```ts
import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'

// Fires inside an unclosed `[[…` (any chars that aren't `]`), suggesting note
// paths; applying a completion inserts `path]]` to close the link.
export function wikilinkCompletions(targets: string[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const open = context.matchBefore(/\[\[[^\]]*/)
    if (!open) return null
    return {
      from: open.from + 2,
      options: targets.map((path) => ({ label: path, type: 'link', apply: `${path}]]` })),
    }
  }
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm -C client test -- wikilinkCompletions && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/package.json pnpm-lock.yaml client/src/hooks/wikilinkCompletions.ts client/src/hooks/wikilinkCompletions.test.ts
git commit -m "Add wikilinkCompletions completion source"
```

---

### Task 2: Wire autocomplete into the editor via `NoteView`

**Files:**
- Modify: `client/src/hooks/useCodeMirrorEditor.ts`
- Modify: `client/src/hooks/useCodeMirrorEditor.test.tsx`
- Modify: `client/src/pages/vault/NoteView.tsx`

**Interfaces:**
- Consumes: `wikilinkCompletions` (Task 1); `useVaultTree` (Slice 2a).
- Produces: `useCodeMirrorEditor` gains an optional `wikilinkTargets?: string[]`
  option; when set, it registers `autocompletion` with the wikilink source.
  `NoteView` passes the vault's note paths (from `useVaultTree`).

- [ ] **Step 1: Add the option to `useCodeMirrorEditor`**

In `client/src/hooks/useCodeMirrorEditor.ts`:
- add imports:
  ```ts
  import { autocompletion } from '@codemirror/autocomplete'
  import { wikilinkCompletions } from './wikilinkCompletions.js'
  ```
- extend the options interface:
  ```ts
  interface UseCodeMirrorEditorOptions {
    doc: string
    onChange: (doc: string) => void
    readOnly?: boolean
    wikilinkTargets?: string[]
  }
  ```
- destructure `wikilinkTargets = []` in the function signature.
- in the `extensions` array, add (after `markdownMarkerHiding,`):
  ```ts
        autocompletion({ override: [wikilinkCompletions(wikilinkTargets)] }),
  ```
  (`wikilinkTargets` is captured at mount, same as `doc`/`readOnly`; the
  eslint-disable on the mount effect already covers it.)

- [ ] **Step 2: Add a hook test for the option**

Add to `client/src/hooks/useCodeMirrorEditor.test.tsx`. Because the autocomplete
tooltip is unreliable under happy-dom, this test only asserts the editor mounts
and stays functional with `wikilinkTargets` set (the completion *logic* is
covered by Task 1's unit test). Update the `Harness` to accept and forward
`wikilinkTargets`, then:
```tsx
  it('mounts with wikilinkTargets set (autocomplete wired, editor intact)', () => {
    const { getByTestId } = render(
      <Harness doc={'body'} onChange={vi.fn()} wikilinkTargets={['people/jane']} />,
    )
    const container = getByTestId('editor-container')
    expect(container.querySelector('.cm-content')?.textContent).toBe('body')
  })
```
(Extend `Harness`'s prop type with `wikilinkTargets?: string[]` and pass it
through to `useCodeMirrorEditor`.)

- [ ] **Step 3: Run, confirm the new hook test passes; the source isn't broken**

Run: `pnpm -C client test -- useCodeMirrorEditor`
Expected: PASS (all pre-existing hook tests + the new one).

- [ ] **Step 4: Wire `NoteView` to supply the targets**

In `client/src/pages/vault/NoteView.tsx`:
- add `import { useVaultTree } from '../../hooks/useVaultTree.js'`
- inside `NoteEditor`, before the `useCodeMirrorEditor` call, derive the targets
  from the cached vault tree:
  ```ts
  const tree = useVaultTree(vaultId)
  const wikilinkTargets = tree.data ? Object.values(tree.data).flat().map((n) => n.path) : []
  ```
- pass it to the hook:
  ```ts
  const editorRef = useCodeMirrorEditor({ doc: initialBody, onChange: handleChange, readOnly, wikilinkTargets })
  ```
  (`useVaultTree(vaultId)` shares `VaultLayout`'s already-cached
  `['vault-tree', vaultId]` query — no extra network request.)

- [ ] **Step 5: Update the NoteView test setup**

`NoteView.test.tsx` stubs `fetch`. `useVaultTree` will now also fire from
`NoteView`, hitting `GET /api/vaults/:id/tree`. Update the test's `fetch` stub so
a tree request resolves (an empty tree `{}` is fine — the tests don't assert
autocomplete). If the stub is a single `mockResolvedValue`, switch it to a
`mockImplementation` that returns `{}` for a `/tree` URL and the existing
note/PUT responses otherwise, so no request 404s and no test regresses. Run the
NoteView tests and confirm they still pass.

- [ ] **Step 6: Full suite + typecheck + lint + build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm lint && pnpm -C client build`
Expected: all pass/exit 0.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/useCodeMirrorEditor.ts client/src/hooks/useCodeMirrorEditor.test.tsx client/src/pages/vault/NoteView.tsx client/src/pages/vault/NoteView.test.tsx
git commit -m "Wire [[ wikilink autocomplete into the note editor"
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

Update the editor status copy: typing `[[` now autocompletes vault note paths.
Note the honest boundary: clickable rendered wikilinks and link-to-create are
the next increment. Update the two slice-status lines to add Slice 2c-1.

- [ ] **Step 3: Update STATE.md**

Record Slice 2c-1 complete; name the next increment (2c-2: clickable rendered
`[[links]]` that navigate, and clicking a missing link creates the note). Keep
the file at or under 40 lines.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/agents/STATE.md
git commit -m "Update README and STATE.md for Slice 2c-1"
```

---

## Self-Review

**Spec coverage:** Editor spec §Wikilinks bullet 1 — "Typing `[[` triggers
autocomplete against existing notes in the current vault" — is covered. Bullets
2 (clickable rendered link) and 3 (link-to-create) are explicitly the next
increment (2c-2), documented, not silently dropped.

**Placeholder scan:** no TBD/TODO; Tasks 1–2 have complete code. Task 2 Step 5
describes the test-stub adjustment rather than a verbatim block because it must
match `NoteView.test.tsx`'s existing fetch-stub shape (the implementer reads it
first) — the required change (a `/tree` request must resolve, e.g. to `{}`) is
fully specified.

**Type consistency:** `wikilinkCompletions(targets: string[]): CompletionSource`
(Task 1) is used exactly that way in `useCodeMirrorEditor` (Task 2). The new
`wikilinkTargets?: string[]` option threads: `NoteView` derives it from
`useVaultTree`'s `VaultTree` (`Record<string, NoteSummary[]>` → `.path` values)
and passes it to the hook. The target format (note `path`) matches the backend's
resolution key.
