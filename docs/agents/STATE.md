# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE — Slices 1 (Scaffold + Auth), 2a (vault tree +
  read-only note view), and 2b-1 (CodeMirror 6 basic editing + debounced
  autosave) complete. 2b-1 on `feat/ui-editor-2b1` (stacked on
  `feat/ui-editor-2a`), reviewed clean end to end, PR next.
- **Done**: full backend, hardened + documented (130 tests; real ONNX
  embeddings, real Dockerfile/Postgres, helmet+cors, Dependabot; see
  `backend-reference.md` for full architecture/security/runbook).
  Slice 1 UI (`client/`, Tasks 1-13): scaffold, Tailwind design system,
  shadcn primitives, typed API client + auth functions, session hook,
  react-router + `RequireAuth` guard, every auth page. Slice 2a: vault
  list on HomePage, `VaultLayout` file-tree sidebar, read-only `NoteView`.
  Slice 2b-1 (5 tasks): `updateNote` API + `useUpdateNote` mutation,
  `useCodeMirrorEditor` (CM6, markdown syntax highlight), `NoteView` now
  an editable CM6 body that debounce-saves (key-remount per note path).
  Root verification green: lint, typecheck, 51 client + 130 server tests,
  `client` production build.
- **Current task**: none — Slice 2b-1 done and verified end to end.
- **Next step**: continue Slice 2b. Two candidate next increments (owner's
  pick): (a) live-preview markdown rendering inside CM6 (typed syntax
  rendered inline — a decorations/ViewPlugin feature); (b) frontmatter
  property panel + note lifecycle (create/rename/delete) + the read/edit
  permission lock. Then 2c (wikilinks). Write the plan against
  `2026-07-09-editor-design.md` before building.
- **Known deferred** (all deliberate, documented, verified via a
  full-repo audit 2026-07-18): cloud storage/scheduled backups,
  cli-visualizer (#9, assigned), cross-file call-graph resolution,
  symbol-level embeddings, Leiden upgrade, partial/selective restore,
  anomaly detection for runaway AI edit loops, single-process
  architecture (see implementation.md). MFA *enrollment* UI is Settings-
  page work for a later slice, not built yet (Global Constraints).
- **Open issues**: #9 (deferred, assigned)
