# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE — the **Editor (Slice 2b) is COMPLETE in `dev`** (Slices
  1–2b-7 all merged; 2a–2b-3 via consolidating PR #68 after the stacked PRs
  were mis-merged into parents; 2b-4 #69, 2b-5 #70, 2b-6 #76, 2b-7 #77 self-
  merged); Slice 2c wikilinks merged: 2c-1 #78, 2c-2 #79. Slice 2c-3
  (link-to-create) complete on `feat/ui-wikilinks-2c3` (off dev), PR +
  self-merge next — this COMPLETES Slice 2c (wikilinks). **Workflow: PRs
  target `dev` directly (NOT stacked); I self-merge after CI green + clean
  review** (Taha re-authorized 2026-07-25 while away; scope = PR→dev only,
  NOT dev→prod). Backend issue #66 open.
- **Done**: full backend (130 tests; see `backend-reference.md`). UI: Slice 1
  (auth, design system, `RequireAuth`), 2a (vault list, `FileTree`, `NoteView`),
  **Editor complete (2b)** — `useCodeMirrorEditor` w/ debounced save,
  `readOnly`/`canEdit` lock, `PropertyPanel`/`TagInput` frontmatter,
  `NewNoteForm` create, `NoteActions` rename/delete, `HighlightStyle` +
  `markdownMarkerHiding` live-preview. Slice 2c wikilinks: 2c-1
  `wikilinkCompletions` (`[[` autocomplete), 2c-2 `wikilinkExtension`
  (`MatchDecorator` `.cm-wikilink` + mousedown-navigate on non-cursor line,
  `NoteView` uses `useNavigate`), 2c-3 `handleWikilinkClick` (lib helper: missing
  `type/name` target → `useCreateNote` then navigate). Hook/api names are the
  resume handles; details in README + git. Root verification green: lint,
  typecheck, 104 client + 130 server tests, `client` build.
- **Current task**: none — Slice 2c (wikilinks) COMPLETE.
- **Next step** (autonomous, "keep going"): Slice 3 — Search (an OVERLAY /
  ⌘K-style, not a page, per `2026-07-17-hosted-ui-structure-design.md`; backend
  has hybrid keyword+semantic search — read `2026-07-11-search-design.md` +
  server search routes first). Then Slices 4–7 (Team / Vault-settings / Admin /
  Settings incl. MFA-enrollment UI / ⌘K palette). Carried wikilink minors:
  `]]`-doubling on re-complete, targets frozen at mount, first-line link
  needs a cursor-move before it's clickable.
- **Known deferred** (deliberate, audit-verified 2026-07-18): cloud
  storage/scheduled backups, cli-visualizer (#9, assigned), cross-file
  call-graph resolution, symbol-level embeddings, Leiden upgrade,
  partial/selective restore, anomaly detection for runaway AI edit loops,
  single-process architecture (see implementation.md). MFA *enrollment* UI
  is Settings-page work for a later slice (Global Constraints).
- **Open issues**: #9 (deferred, assigned); #66 (updateNote race, backend)
