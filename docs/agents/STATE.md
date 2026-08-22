# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE. Slices 1, 2a, 2b (Editor), 2c (wikilinks) and 3a (⌘K
  search overlay) are all merged to `dev`. **Workflow: PRs target `dev` directly
  (NOT stacked); I self-merge after CI green + clean review** (Taha
  re-authorized 2026-07-25; scope = PR→dev only, NOT dev→prod).
- **Done**: full backend (135 tests; see `backend-reference.md`). UI: Slice 1
  (auth, `RequireAuth`), 2a (vault list, `FileTree`, `NoteView`), 2b Editor
  (`useCodeMirrorEditor`, debounced save, `readOnly`/`canEdit` lock,
  `PropertyPanel`/`TagInput`, `NewNoteForm`, `NoteActions`, `HighlightStyle` +
  `markdownMarkerHiding` live-preview), 2c wikilinks (`wikilinkCompletions`,
  `wikilinkDecorations`, `handleWikilinkClick`), 3a Search (`search` API +
  `useSearch`, `SearchOverlay`, `GlobalSearch` ⌘K in `RequireAuth`). Those
  names are the resume handles; details in README + git.
- **Current task**: backend branch `fix/semantic-edge-lifecycle`. Semantic
  edges are now stored **directed** — the source owns its top-k rows,
  `buildGraph()` dedups both directions on read — fixing #91, where deleting by
  either side destroyed edges another node owned. `purgeNote()` and
  `syncRepositoryFiles()` now clear semantic edges explicitly (#92: polymorphic
  table, no FK, nothing cascades). Migration
  `0010_backfill_semantic_edge_directions.sql` mirrors pre-existing rows so no
  edge is lost on upgrade. Plan:
  `docs/superpowers/plans/2026-08-22-graph-engineering-findings.md`.
- **NOT in that branch**: #93 — profile `buildGraph()`'s uncached per-request
  Louvain (1k/5k/10k nodes) before optimizing. Deliberately out of scope, open.
- **Next step**: 3b — keyboard nav in the search overlay (arrow up/down, Enter
  to open). Then Slices 4–7 (Team / Vault-settings / Admin / Settings incl.
  MFA-enrollment UI / ⌘K palette). Carried minors: wikilink `]]`-doubling,
  targets frozen at mount, first-line link needs cursor-move; search backdrop
  `bg-black/40`, error state reads "no results".
- **Known deferred**: cloud storage/scheduled backups, cli-visualizer (#9,
  assigned), symbol-level embeddings, partial/selective restore, anomaly
  detection for runaway AI edit loops, single-process architecture (see
  implementation.md). MFA *enrollment* UI is later-slice Settings work.
  **Decided against 2026-08-22** (graph plan — do not re-open): Leiden, a graph
  database, GraphRAG-style LLM community summaries, cross-file call resolution.
- **Open issues**: #9 (deferred); #66 (updateNote race); #93 (Louvain profile)
