# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE. Slices 1, 2a, 2b (Editor), 2c (wikilinks), 3a (⌘K
  search) merged to `dev`. **PRs target `dev` directly (NOT stacked); I
  self-merge after CI green + clean review** (re-authorized 2026-07-25; scope
  = PR→dev only, NOT dev→prod).
- **Done**: full backend (135 tests, `backend-reference.md`). UI: Slice 1
  (auth, `RequireAuth`), 2a (vault list, `FileTree`, `NoteView`), 2b Editor
  (`useCodeMirrorEditor`, debounced save, `canEdit` lock, `PropertyPanel`,
  `NoteActions`, `markdownMarkerHiding`), 2c wikilinks (`wikilink*`), 3a
  search (`useSearch`, `SearchOverlay`, `GlobalSearch`). Names = resume handles.
- **Graph plan fully implemented** (#91/#92/#93 via PRs #94/#95; plan
  `docs/superpowers/plans/2026-08-22-graph-engineering-findings.md`): semantic
  edges stored **directed**, dedup'd on read by `buildGraph()`; purge paths
  clear edges explicitly (polymorphic table, no FK). `pnpm profile-graph`:
  ≈500ms at 10k notes, Louvain is NOT the bottleneck. Table in implementation.md.
- **Current task**: none. Unit 1a done on `feat/unit-1a-vaults`
  (ledger: `.superpowers/sdd/2026-08-22-unit-1a-graph-shell-backend/`, repo
  root, git-ignored): vault soft delete + owner-only purge (mirrors
  `purgeNote`); `aggregate=community` and `community=<n>` drill-down wired
  through `/repositories/:id/graph`, `GET .../graph-preference` added.
- **⚠ THE UI GAP** — most important fact for the next session: the client is
  the note-taking core only. The backend's graph, real-time collaboration,
  repository/code-graph, vault sharing, admin, and MFA features have **no
  client UI at all** (grep `client/src` for `graph|repositor|yjs|collab`
  returns nothing; `yjs` isn't even a client dependency). MCP is the
  exception — AI clients consume it directly, so it needs no UI.
- **Next step**: plan the remaining UI modules — 3b (search overlay keyboard
  nav), then Slices 4–7 (Team / Vault-settings / Admin / Settings incl. MFA
  enrollment / ⌘K palette). Carried minors: wikilink `]]`-doubling, targets
  frozen at mount, search backdrop `bg-black/40`, error "no results".
- **Known deferred**: cloud storage/scheduled backups, cli-visualizer (#9),
  symbol-level embeddings, partial/selective restore, anomaly detection for
  runaway AI edit loops, single-process architecture (implementation.md).
  **Decided against 2026-08-22** (do not re-open): Leiden, a graph database,
  GraphRAG-style LLM community summaries, cross-file call resolution.
- **Open issues**: #9 (deferred, assigned); #66 (updateNote lost-update race)
