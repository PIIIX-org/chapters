# UI Slice 2c-3: Wikilink Link-to-Create Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a `[[type/name]]` wikilink to a note that doesn't exist yet
**creates** it (type-first, from the path) and navigates to it — completing the
wikilinks slice (2c).

**Architecture:** A pure `handleWikilinkClick(target, vaultId, existingTargets,
canCreate, navigate, create)` helper decides: navigate if the target already
exists (or the user can't create); otherwise, if the target parses as
`type/name`, create it then navigate; else just navigate (→ "Note not found").
`NoteView` wires it with `useCreateNote` (which invalidates the vault tree),
replacing the current navigate-only `onWikilinkClick`.

**Tech Stack:** existing `useCreateNote`/`createNote` (Slice 2b-4), React Router
`useNavigate`. No new dependency.

## Global Constraints

- **Wikilink target = note `path` (`type/name`).** Link-to-create splits on the
  FIRST `/`: `type` = before, `name` = after. The server validates both as slugs
  (`^[a-z0-9][a-z0-9-]*$`) — an unparseable or invalid target results in a
  rejected create, and the handler navigates anyway (→ "Note not found"), never
  throwing.
- **Only edit-capable users create.** When the note is read-only (`readOnly`),
  a click on a missing wikilink just navigates (the server would 404 a create
  anyway); pass `canCreate = !readOnly`.
- **Existence check** uses the editor's `wikilinkTargets` (the vault tree's note
  paths). If the target is in that list → navigate directly (no create attempt).
  If not → attempt create; because create uses `onSettled` (fires on success OR
  error), a stale-list false-negative (target created after mount → `409 already
  exists`) still navigates correctly.
- After a successful create, `useCreateNote` invalidates `['vault-tree', vaultId]`
  (so the sidebar/autocomplete pick up the new note) — already its behavior.
- pnpm; strict TS + `verbatimModuleSyntax`; Vitest explicit imports; happy-dom;
  no new deps, no invented styles. Root `pnpm lint` clean before each commit. No
  `_`-prefixed unused vars.
- Anti-slop tooling (`impeccable`) fires on writes/edits — fix findings first.

---

### Task 1: `handleWikilinkClick` helper + `NoteView` wiring

**Files:**
- Create: `client/src/lib/handleWikilinkClick.ts`
- Create: `client/src/lib/handleWikilinkClick.test.ts`
- Modify: `client/src/pages/vault/NoteView.tsx`

**Interfaces:**
- Consumes: `useCreateNote` (Slice 2b-4); the editor's `onWikilinkClick`.
- Produces: `handleWikilinkClick(target, vaultId, existingTargets, canCreate, navigate, create): void`
  — pure dispatcher (navigate | create-then-navigate). `NoteView` calls it from
  `onWikilinkClick`.

- [ ] **Step 1: Write the failing helper test**

`client/src/lib/handleWikilinkClick.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { handleWikilinkClick } from './handleWikilinkClick'

describe('handleWikilinkClick', () => {
  it('navigates directly to an existing note (no create)', () => {
    const navigate = vi.fn()
    const create = vi.fn()
    handleWikilinkClick('people/jane', 'v1', ['people/jane'], true, navigate, create)
    expect(navigate).toHaveBeenCalledWith('/vaults/v1/notes/people/jane')
    expect(create).not.toHaveBeenCalled()
  })

  it('creates a missing note (type/name) then navigates', () => {
    const navigate = vi.fn()
    const create = vi.fn((_input, onSettled: () => void) => onSettled())
    handleWikilinkClick('people/bob', 'v1', ['people/jane'], true, navigate, create)
    expect(create).toHaveBeenCalledWith({ type: 'people', name: 'bob' }, expect.any(Function))
    expect(navigate).toHaveBeenCalledWith('/vaults/v1/notes/people/bob')
  })

  it('does not create when the user cannot create (read-only) — just navigates', () => {
    const navigate = vi.fn()
    const create = vi.fn()
    handleWikilinkClick('people/bob', 'v1', ['people/jane'], false, navigate, create)
    expect(create).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/vaults/v1/notes/people/bob')
  })

  it('does not create an unparseable target (no type/name) — just navigates', () => {
    const navigate = vi.fn()
    const create = vi.fn()
    handleWikilinkClick('justaname', 'v1', [], true, navigate, create)
    expect(create).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/vaults/v1/notes/justaname')
  })
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `pnpm -C client test -- handleWikilinkClick`
Expected: FAIL — `./handleWikilinkClick` doesn't exist yet.

- [ ] **Step 3: Implement the helper**

`client/src/lib/handleWikilinkClick.ts`:
```ts
// Decides what a wikilink click does: navigate to an existing note, or (for an
// edit-capable user) create a missing `type/name` note then navigate.
export function handleWikilinkClick(
  target: string,
  vaultId: string,
  existingTargets: string[],
  canCreate: boolean,
  navigate: (to: string) => void,
  create: (input: { type: string; name: string }, onSettled: () => void) => void,
): void {
  const to = `/vaults/${vaultId}/notes/${target}`
  if (!canCreate || existingTargets.includes(target)) {
    navigate(to)
    return
  }
  const slash = target.indexOf('/')
  if (slash <= 0 || slash >= target.length - 1) {
    navigate(to) // no parseable type/name — can't create; navigate (not-found)
    return
  }
  create({ type: target.slice(0, slash), name: target.slice(slash + 1) }, () => navigate(to))
}
```

- [ ] **Step 4: Run the helper test, verify it passes**

Run: `pnpm -C client test -- handleWikilinkClick && pnpm -C client typecheck && pnpm lint`
Expected: all pass, exit 0.

- [ ] **Step 5: Wire into `NoteView`**

In `client/src/pages/vault/NoteView.tsx`:
- add `import { useCreateNote } from '../../hooks/useCreateNote.js'`
- add `import { handleWikilinkClick } from '../../lib/handleWikilinkClick.js'`
- inside `NoteEditor`, add `const createNote = useCreateNote(vaultId)` (near the
  other hooks).
- replace the current `onWikilinkClick` line
  ```ts
    onWikilinkClick: (target) => navigate(`/vaults/${vaultId}/notes/${target}`),
  ```
  with:
  ```ts
    onWikilinkClick: (target) =>
      handleWikilinkClick(
        target,
        vaultId,
        wikilinkTargets,
        !readOnly,
        (to) => navigate(to),
        (input, onSettled) => createNote.mutate(input, { onSettled }),
      ),
  ```
  (Leave the rest of `NoteEditor` unchanged.)

- [ ] **Step 6: Update the NoteView test fetch stub**

`NoteView.test.tsx` already stubs `fetch` (with a `/tree` branch from 2c-1).
Adding `useCreateNote` doesn't fire a request on its own (it's a mutation, only
fires on `.mutate`), and none of the existing NoteView tests click a wikilink —
so no stub change should be needed. Run `pnpm -C client test -- NoteView` and
confirm the 5 tests still pass. If any test unexpectedly fires a POST
`/vaults/:id/notes`, add a branch returning a created-note `mockJsonResponse(201,
…)` — but this is not expected.

- [ ] **Step 7: Full suite + typecheck + lint + build**

Run: `pnpm -C client test && pnpm -C client typecheck && pnpm lint && pnpm -C client build`
Expected: all pass/exit 0.

- [ ] **Step 8: Commit**

```bash
git add client/src/lib/handleWikilinkClick.ts client/src/lib/handleWikilinkClick.test.ts client/src/pages/vault/NoteView.tsx
git commit -m "Create a missing note when its [[wikilink]] is clicked (link-to-create)"
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

Update the wikilink copy: clicking a `[[link]]` to a note that doesn't exist yet
creates it (type-first, from the path) and opens it — the wikilinks slice (2c)
is now complete. Update the slice-status lines to reflect 2c done; name the next
work: Slice 3 (Search).

- [ ] **Step 3: Update STATE.md**

Record Slice 2c-3 complete and **Slice 2c (wikilinks) complete**. Name the next
slice: Slice 3 — Search (per `2026-07-17-hosted-ui-structure-design.md`: a
search overlay, not a page; and `2026-07-11-search-design.md`). Keep the file at
or under 40 lines.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/agents/STATE.md
git commit -m "Update README and STATE.md for Slice 2c-3 (wikilinks complete)"
```

---

## Self-Review

**Spec coverage:** Editor spec §Wikilinks bullet 3 — "Clicking a link to a note
that doesn't exist yet **creates** it — inferring its `type` from context where
possible … otherwise falling back to the type-first creation flow" — is covered
for the direct case: a `[[type/name]]` target creates that note. The spec's
"infer type from a single-name link" / interactive type-first *prompt* for a
bare `[[name]]` is a further refinement (a bare name currently just navigates to
"Note not found") — a documented boundary, not a silent drop. Bullets 1
(autocomplete, 2c-1) and 2 (clickable nav, 2c-2) are already shipped, so this
completes the slice's core.

**Placeholder scan:** no TBD/TODO; complete runnable code.

**Type consistency:** `handleWikilinkClick(target, vaultId, existingTargets,
canCreate, navigate, create)` (Task 1) is called with exactly those args by
`NoteView`, where `create` adapts `useCreateNote`'s `.mutate(input, { onSettled
})`. The `{ type, name }` shape matches `CreateNoteInput` (Slice 2b-4). `navigate`
targets `/vaults/${vaultId}/notes/${target}` — the same route format the rest of
the editor uses.
