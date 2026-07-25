# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE — Slices 1–2b-6 all MERGED to `dev` (2a–2b-3 via
  consolidating PR #68 after the stacked PRs were mis-merged into parent
  branches; 2b-4 #69, 2b-5 #70, 2b-6 #76 self-merged). Slice 2b-7 (live-
  preview marker hiding) complete on `feat/ui-editor-2b7` (off dev), PR +
  self-merge next — this COMPLETES the Editor (Slice 2b). **Workflow: PRs
  target `dev` directly (NOT stacked); I self-merge after CI green + clean
  review** (Taha re-authorized 2026-07-25 while away; scope = PR→dev only,
  NOT dev→prod). Backend issue #66 open.
- **Done**: full backend, hardened + documented (130 tests; see
  `backend-reference.md`). UI: Slice 1 (scaffold, design system, shadcn
  primitives, typed API client, auth pages, `RequireAuth`). Slice 2a (vault
  list, `VaultLayout` file-tree sidebar, read-only `NoteView`). Slice 2b-1
  (`useCodeMirrorEditor` CM6 body, debounced `updateNote`). Slice 2b-2
  (`readOnly` + `canEdit` — read vaults locked). Slice 2b-3 (`TagInput` +
  `PropertyPanel` editable frontmatter, `type` read-only, extras preserved).
  Slice 2b-4 (`createNote`/`NewNoteForm` type-first create + `canEdit`-gated
  "New note"). Slice 2b-5 (`renameNote`/`deleteNote` + hooks + `NoteActions`
  inline rename/two-step-delete-confirm in `FileTree`, `canEdit`-gated,
  navigates when the open note is renamed/deleted). Slice 2b-6 (markdown
  `HighlightStyle` — inline `.cm-md-*` styling). Slice 2b-7
  (`markdownMarkerHiding` ViewPlugin — hides `#`/`**`/`` ` `` at rest, reveals
  on the cursor's line; keeps fenced-code fences + Setext underlines visible).
  Root verification green: lint, typecheck, 90 client + 130 server tests,
  `client` build.
- **Current task**: none — Slice 2b-7 done; **the Editor (Slice 2b) is
  complete**.
- **Next step** (autonomous, "keep going"): Slice 2c — wikilinks (`[[`
  typeahead against vault notes, clickable rendered links, link-to-create),
  then Slices 3–7 (Search/Team/Vault-settings/Admin/Settings + ⌘K palette).
  Plans against `2026-07-09-editor-design.md` and
  `2026-07-17-hosted-ui-structure-design.md`.
- **Known deferred** (deliberate, audit-verified 2026-07-18): cloud
  storage/scheduled backups, cli-visualizer (#9, assigned), cross-file
  call-graph resolution, symbol-level embeddings, Leiden upgrade,
  partial/selective restore, anomaly detection for runaway AI edit loops,
  single-process architecture (see implementation.md). MFA *enrollment* UI
  is Settings-page work for a later slice (Global Constraints).
- **Open issues**: #9 (deferred, assigned); #66 (updateNote race, backend)
