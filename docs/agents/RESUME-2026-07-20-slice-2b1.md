# Resume note: Slice 2b-1 (CodeMirror editing), paused 2026-07-20

Not part of the normal STATE.md rotation — a task-level pause point inside
an in-progress slice, written on explicit request. Delete this file once
Slice 2b-1 ships and STATE.md is updated to reflect it; don't let it become
a second source of truth alongside STATE.md/progress.md.

## Where things stand

**Branch:** `feat/ui-editor-2b1`, stacked on `feat/ui-editor-2a` (PR #62,
open, awaiting owner review), itself stacked on `feat/ui-scaffold-auth`
(PR #60, open, awaiting owner review). Working tree clean, nothing
uncommitted, HEAD at `a7ee8a0`.

**Plan:** `docs/superpowers/plans/2026-07-20-ui-editor-2b1-codemirror-editing.md`
(5 tasks — replace NoteView's read-only `<pre>` body with a real,
editable CodeMirror 6 instance, debounce-save to the existing PUT
`/vaults/:id/notes/*` endpoint). Explicitly out of scope for this
increment: live-preview rendering, frontmatter property panel, note
create/rename/delete, permission-aware edit lock, wikilinks — all later
2b sub-increments or 2c.

**Executing via:** superpowers:subagent-driven-development. Ledger:
`.superpowers/sdd/progress.md` (namespaced `2b1-Task N`).

### Done and reviewed clean
- **Task 1** — `updateNote` API function (`client/src/api/notes.ts`).
  Commits `7aa39d3..3ced05b`. Review: approved, no findings.
- **Task 2** — `useUpdateNote` mutation hook (`client/src/hooks/useUpdateNote.ts`).
  Commits `3ced05b..a4bded1`. Review: approved. Minor carried forward:
  test only covers the happy path, doesn't directly assert
  `invalidateQueries(['note', vaultId, path])` fired — plan-inherited gap,
  not a functional bug.
- **Task 3** — `useCodeMirrorEditor` hook (`client/src/hooks/useCodeMirrorEditor.ts`).
  Commits `a4bded1..59c0c4b`. Review: approved. The known CM6-vs-DOM-emulator
  risk flagged in the plan's Global Constraints did **not** materialize —
  happy-dom's `Range` implementation is sufficient, no polyfill needed
  (empirically confirmed, not assumed). Minor carried forward: `onChange`-
  on-edit and unmount/`destroy()` branches untested at the hook level
  (expected to be indirectly covered by Task 4's debounce-save test).

### Done, NOT yet reviewed — this is the actual pause point
- **Task 4** — wire CodeMirror into `NoteView` with debounced save
  (`client/src/pages/vault/NoteView.tsx` + test). Commit `a7ee8a0`
  (base `59c0c4b`). Implementer status: **DONE_WITH_CONCERNS**. Full
  report at `.superpowers/sdd/task-4-report.md`.

  Two small, reported, behavior-neutral deviations from the plan's literal
  code (both explained in the report): a `useRef<T>()` needed an explicit
  `| undefined, undefined` for React 19's stricter types, and an unused
  `getDefaultNormalizer` import was dropped because `pnpm lint` flags it.

  **The one real open concern:** `pnpm lint` fails at the repo root on a
  **pre-existing** `react-hooks/refs` error in Task 3's
  `client/src/hooks/useCodeMirrorEditor.ts` — the implementer confirmed via
  `git stash` that this predates Task 4's changes (i.e., Task 3 shipped
  with a lint failure that its own review didn't catch, likely because
  Task 3's review ran typecheck/build but not lint). **This will block CI
  once a PR is opened and needs to be fixed before this branch ships.**

  The debounce-save test (the delicate one — fake timers +
  `EditorView.findFromDOM` to simulate a live edit) worked exactly as
  written in the plan, no adjustment needed — flagging since it was the
  highest-risk piece of this task and it came back clean.

## What's next, in order

1. **Fix the `react-hooks/refs` lint error** in `useCodeMirrorEditor.ts`
   first — either as a small standalone fix commit on this branch, or by
   re-opening Task 3 (controller's call; the finding surfaced during Task
   4's work, not Task 3's own review, so it wasn't caught by that gate).
   Confirm `pnpm lint` is clean at the repo root afterward.
2. Generate the Task 4 review package
   (`scripts/review-package 59c0c4b a7ee8a0` from the
   subagent-driven-development skill dir) and dispatch the Task 4 task
   reviewer (brief: `.superpowers/sdd/task-4-brief.md`, report:
   `.superpowers/sdd/task-4-report.md`).
3. Resolve any review findings (fix + re-review loop), then log
   `2b1-Task 4: complete (...)` in `.superpowers/sdd/progress.md`.
4. **Task 5** — final verification + README/STATE.md update (not started).
5. Final whole-branch review (opus tier), package via
   `scripts/review-package <merge-base> HEAD`.
6. `superpowers:finishing-a-development-branch` → push, open PR from
   `sadeqisaidmohaddes-star`'s GitHub account, base `feat/ui-editor-2a`
   (retarget to `dev` later once #62 merges). Leave for the owner's manual
   review — no auto-merge, per the current standing workflow.
7. Continue with the rest of Slice 2b (live-preview rendering, property
   panel, autosave refinement, note create/rename/delete, permission
   lock), then 2c (wikilinks), then Slices 3-7 — per the standing `/loop`
   "finish all the slices" directive, unless the user redirects.

## Everything-online check

All commits through `a7ee8a0` exist only on the local `feat/ui-editor-2b1`
branch — **not yet pushed**. That's normal mid-slice (PRs open once a
slice/sub-slice is done and reviewed, not per-task), but flagging it
explicitly since "keep everything online" is a standing instruction: this
branch will get pushed at step 6 above, not before.
