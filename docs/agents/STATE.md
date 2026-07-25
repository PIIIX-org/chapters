# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE — Slices 1, 2a, 2b-1, 2b-2, 2b-3 all MERGED to `dev`
  (2a–2b-3 landed via consolidating PR #68 — the stacked PRs #62/#64/#65/#67
  had been mis-merged into parent branches, not dev; #68 fixed that). Slice
  2b-4 (type-first note creation) complete on `feat/ui-editor-2b4` (off dev),
  PR + self-merge next. **Workflow now: PRs target `dev` directly (NOT
  stacked); I merge them myself after CI green + clean review** (Taha
  re-authorized self-merge 2026-07-25 while away). Backend issue #66 open
  (updateNote lost-update race, tracked).
- **Done**: full backend, hardened + documented (130 tests; see
  `backend-reference.md`). UI: Slice 1 (scaffold, design system, shadcn
  primitives, typed API client, auth pages, `RequireAuth`). Slice 2a (vault
  list, `VaultLayout` file-tree sidebar, read-only `NoteView`). Slice 2b-1
  (`useCodeMirrorEditor` CM6 body, debounced `updateNote`). Slice 2b-2
  (`readOnly` + `canEdit` — read vaults locked). Slice 2b-3 (`TagInput` +
  `PropertyPanel` editable frontmatter, `type` read-only, extras preserved).
  Slice 2b-4 (`createNote`/`useCreateNote`/`NewNoteForm` type-first create +
  `canEdit`-gated "New note" in `VaultLayout`). Root verification green:
  lint, typecheck, 73 client + 130 server tests, `client` build.
- **Current task**: none — Slice 2b-4 done and verified end to end.
- **Next step** (autonomous, "keep going"): 2b-5 note rename + delete in the
  file tree (backend: POST `/vaults/:id/notes-rename` `{from,to}`, DELETE
  `/vaults/:id/notes/*`, both `edit`-gated; invalidate `['vault-tree',id]`;
  navigate away if the open note is deleted/renamed). Then live-preview
  rendering, then 2c (wikilinks), then Slices 3–7 (Search/Team/Vault-settings/
  Admin/Settings + ⌘K). Plans against `2026-07-09-editor-design.md` and
  `2026-07-17-hosted-ui-structure-design.md`.
- **Known deferred** (all deliberate, documented, verified via a
  full-repo audit 2026-07-18): cloud storage/scheduled backups,
  cli-visualizer (#9, assigned), cross-file call-graph resolution,
  symbol-level embeddings, Leiden upgrade, partial/selective restore,
  anomaly detection for runaway AI edit loops, single-process
  architecture (see implementation.md). MFA *enrollment* UI is Settings-
  page work for a later slice, not built yet (Global Constraints).
- **Open issues**: #9 (deferred, assigned)
