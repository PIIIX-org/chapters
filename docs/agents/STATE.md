# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE — Slices 1 (Scaffold + Auth), 2a (vault tree +
  read-only note view), 2b-1 (CodeMirror 6 basic editing + debounced
  autosave), and 2b-2 (permission-aware editor lock) complete. Editor-
  completion increment in progress; PRs #60/#62/#64 (Slices 1/2a/2b-1)
  awaiting owner review; 2b-2 on `feat/ui-editor-2b2` (stacked on 2b-1).
- **Done**: full backend, hardened + documented (130 tests; real ONNX
  embeddings, real Dockerfile/Postgres, helmet+cors, Dependabot; see
  `backend-reference.md` for full architecture/security/runbook).
  Slice 1 UI (`client/`, Tasks 1-13): scaffold, Tailwind design system,
  shadcn primitives, typed API client + auth functions, session hook,
  react-router + `RequireAuth` guard, every auth page. Slice 2a: vault
  list on HomePage, `VaultLayout` file-tree sidebar, read-only `NoteView`.
  Slice 2b-1: `updateNote` API + `useUpdateNote`, `useCodeMirrorEditor`
  (CM6), editable debounce-saving `NoteView`. Slice 2b-2: `readOnly` CM6
  option + `canEdit` helper — read-access vaults render a locked,
  non-editable note (no autosave). Root verification green: lint,
  typecheck, 55 client + 130 server tests, `client` production build.
- **Current task**: none — Slice 2b-2 done and verified end to end.
- **Next step**: continue the editor-completion increment (owner delegated
  sequencing via "keep going automatically"): 2b-3 editable frontmatter
  property panel (typed fields, saves via PUT `{frontmatter}`, respects the
  2b-2 lock), then 2b-4 note create/rename/delete in the file tree (backend
  routes exist: POST `/vaults/:id/notes`, POST `/vaults/:id/notes-rename`,
  DELETE `/vaults/:id/notes/*`, all gated `edit`). Then live-preview
  rendering, then 2c (wikilinks). Plans against `2026-07-09-editor-design.md`.
- **Known deferred** (all deliberate, documented, verified via a
  full-repo audit 2026-07-18): cloud storage/scheduled backups,
  cli-visualizer (#9, assigned), cross-file call-graph resolution,
  symbol-level embeddings, Leiden upgrade, partial/selective restore,
  anomaly detection for runaway AI edit loops, single-process
  architecture (see implementation.md). MFA *enrollment* UI is Settings-
  page work for a later slice, not built yet (Global Constraints).
- **Open issues**: #9 (deferred, assigned)
