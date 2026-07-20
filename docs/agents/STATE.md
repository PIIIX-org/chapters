# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE — Slice 1 (Scaffold + Auth) and Slice 2a (vault
  tree + read-only note view) complete; Slice 2b (CodeMirror 6 editing)
  next.
- **Done**: full backend, hardened + documented (130 tests; real ONNX
  embeddings, real Dockerfile/Postgres, helmet+cors, Dependabot; see
  `backend-reference.md` for full architecture/security/runbook — details
  of the hardening pass live there and in this file's git history).
  Slice 1 of the UI (`client/`, Tasks 1-13): scaffold, Tailwind design
  system, shadcn primitives, typed API client + auth functions, session
  hook, react-router + `RequireAuth` guard, every auth page. Slice 2a
  (vault tree + read-only note view, 7 tasks): vault list on HomePage,
  `VaultLayout` with file-tree sidebar, read-only `NoteView` rendering
  frontmatter + body. CodeMirror editing, note lifecycle (create/rename/
  delete), and permission-aware edit lock are deferred to 2b; wikilinks
  to 2c. Full root verification green: lint, typecheck, 46 client + 130
  server tests, `client` production build.
- **Current task**: none — Slice 2a done and verified end to end.
- **Next step**: Slice 2b — CodeMirror 6 live-preview editing, typed
  frontmatter property panel, debounced autosave, note create/rename/
  delete, and the read/edit permission lock. Plan not yet written; run
  writing-plans against `2026-07-09-editor-design.md` first.
- **Known deferred** (all deliberate, documented, verified via a
  full-repo audit 2026-07-18): cloud storage/scheduled backups,
  cli-visualizer (#9, assigned), cross-file call-graph resolution,
  symbol-level embeddings, Leiden upgrade, partial/selective restore,
  anomaly detection for runaway AI edit loops, single-process
  architecture (see implementation.md). MFA *enrollment* UI is Settings-
  page work for a later slice, not built yet (Global Constraints).
- **Open issues**: #9 (deferred, assigned)
