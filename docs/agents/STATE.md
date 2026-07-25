# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE — Slices 1–2b-5 all MERGED to `dev` (2a–2b-3 via
  consolidating PR #68 after the stacked PRs were mis-merged into parent
  branches; 2b-4 #69, 2b-5 #70 self-merged). Slice 2b-6 (inline markdown
  styling) complete on `feat/ui-editor-2b6` (off dev), PR + self-merge next.
  **Workflow: PRs target `dev` directly (NOT stacked); I self-merge after CI
  green + clean review** (Taha re-authorized self-merge 2026-07-25 while
  away; scope = PR→dev only, NOT dev→prod). Backend issue #66 open.
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
  `HighlightStyle` — headings/bold/italic/code/links render inline via fixed
  `.cm-md-*` classes; raw markers still shown). Root verification green:
  lint, typecheck, 85 client + 130 server tests, `client` build.
- **Current task**: none — Slice 2b-6 done and verified end to end.
- **Next step** (autonomous, "keep going"): 2b-7 hide markdown syntax markers
  at rest (a `ViewPlugin` + `Decoration.replace` revealing markers only on the
  cursor's line — completes live-preview), then 2c (wikilinks: `[[` typeahead
  + clickable + link-to-create),
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
