# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE — the **Editor (Slice 2b) is COMPLETE in `dev`** (Slices
  1–2b-7 all merged; 2a–2b-3 via consolidating PR #68 after the stacked PRs
  were mis-merged into parents; 2b-4 #69, 2b-5 #70, 2b-6 #76, 2b-7 #77 self-
  merged). Slice 2c-1 (`[[` wikilink autocomplete) complete on
  `feat/ui-wikilinks-2c1` (off dev), PR + self-merge next. **Workflow: PRs
  target `dev` directly (NOT stacked); I self-merge after CI green + clean
  review** (Taha re-authorized 2026-07-25 while away; scope = PR→dev only,
  NOT dev→prod). Backend issue #66 open.
- **Done**: full backend, hardened + documented (130 tests; see
  `backend-reference.md`). UI **Editor complete (Slice 2b)**: Slice 1 (auth,
  design system, API client, `RequireAuth`), 2a (vault list, `FileTree`
  sidebar, `NoteView`), 2b-1 (`useCodeMirrorEditor` + debounced save), 2b-2
  (`readOnly`/`canEdit` lock), 2b-3 (`PropertyPanel`/`TagInput` editable
  frontmatter), 2b-4 (`NewNoteForm` type-first create), 2b-5 (`NoteActions`
  rename/delete), 2b-6 (markdown `HighlightStyle` inline styling), 2b-7
  (`markdownMarkerHiding` — live-preview marker hiding). Slice 2c-1
  (`wikilinkCompletions` source + `useCodeMirrorEditor` `wikilinkTargets` option
  + `autocompletion`; `NoteView` supplies vault note paths from `useVaultTree`).
  Component/hook/api names are the resume handles; details in README + git.
  Root verification green: lint, typecheck, 94 client + 130 server tests,
  `client` build.
- **Current task**: none — Slice 2c-1 (`[[` autocomplete) done.
- **Next step** (autonomous, "keep going"): 2c-2 — clickable rendered
  `[[links]]` (a ViewPlugin decorating wikilinks; click navigates to the note;
  clicking a missing link creates it type-first). Then Slices 3–7
  (Search/Team/Vault-settings/Admin/Settings + ⌘K palette). Also note the
  carried wikilink `]]`-doubling minor (apply appends `]]` unconditionally).
  Plans against `2026-07-09-editor-design.md` and
  `2026-07-17-hosted-ui-structure-design.md`.
- **Known deferred** (deliberate, audit-verified 2026-07-18): cloud
  storage/scheduled backups, cli-visualizer (#9, assigned), cross-file
  call-graph resolution, symbol-level embeddings, Leiden upgrade,
  partial/selective restore, anomaly detection for runaway AI edit loops,
  single-process architecture (see implementation.md). MFA *enrollment* UI
  is Settings-page work for a later slice (Global Constraints).
- **Open issues**: #9 (deferred, assigned); #66 (updateNote race, backend)
