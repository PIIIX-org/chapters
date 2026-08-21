# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE — the **Editor (Slice 2b) is COMPLETE in `dev`** (Slices
  1–2b-7 all merged; 2a–2b-3 via consolidating PR #68 after the stacked PRs
  were mis-merged into parents; 2b-4 #69, 2b-5 #70, 2b-6 #76, 2b-7 #77 self-
  merged); Slice 2c (wikilinks) merged in full: #78/#79/#80. **Slices 1, 2a,
  2b, 2c all in dev.** Slice 3a (⌘K search overlay) complete on
  `feat/ui-search-3a` (off dev), PR + self-merge next. **Workflow: PRs
  target `dev` directly (NOT stacked); I self-merge after CI green + clean
  review** (Taha re-authorized 2026-07-25 while away; scope = PR→dev only,
  NOT dev→prod). Backend issue #66 open.
- **Done**: full backend (130 tests; see `backend-reference.md`). UI: Slice 1
  (auth, `RequireAuth`), 2a (vault list, `FileTree`, `NoteView`), 2b Editor
  (`useCodeMirrorEditor`, debounced save, `readOnly`/`canEdit` lock,
  `PropertyPanel`/`TagInput`, `NewNoteForm`, `NoteActions`, `HighlightStyle` +
  `markdownMarkerHiding` live-preview), 2c wikilinks (`wikilinkCompletions`
  autocomplete, `wikilinkDecorations` clickable-nav, `handleWikilinkClick`
  link-to-create). Slice 3a Search: `search` API + `useSearch`
  (`GET /search?q=&limit=`), `SearchOverlay` (debounced, note-filtered,
  click-navigate, Esc/backdrop close), `GlobalSearch` (⌘K/Ctrl+K, platform-aware
  modifier + !shift to dodge editor delete-line/kill-line) in `RequireAuth`.
  Hook/api names are the resume handles; details in README + git. Root
  verification green: lint, typecheck, 113 client + 130 server tests, build.
- **Current task**: none — Slice 3a (⌘K search overlay) done.
- **Next step** (autonomous, "keep going"): 3b — keyboard nav in the search
  overlay (arrow up/down to move the selection, Enter to open it). Then Slices
  4–7 (Team / Vault-settings / Admin / Settings incl. MFA-enrollment UI / ⌘K
  palette). Carried minors: wikilink `]]`-doubling, targets frozen at mount,
  first-line link needs cursor-move; search backdrop uses `bg-black/40` (no
  overlay token), error state renders as "no results".
- **Known deferred** (deliberate, audit-verified 2026-07-18): cloud
  storage/scheduled backups, cli-visualizer (#9, assigned), cross-file
  call-graph resolution, symbol-level embeddings, Leiden upgrade,
  partial/selective restore, anomaly detection for runaway AI edit loops,
  single-process architecture (see implementation.md). MFA *enrollment* UI
  is Settings-page work for a later slice (Global Constraints).
- **Open issues**: #9 (deferred, assigned); #66 (updateNote race, backend)
