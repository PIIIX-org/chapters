# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: Backend — sub-project 5 (Real-time collaboration)
- **Spec**: `docs/superpowers/specs/2026-07-11-realtime-collaboration-design.md`
- **Done**:
  - Scaffold (#16); Sub-project 1 Auth (#18); Sub-project 2 Notes (#21)
  - Sub-projects 3+4 Graph+Search (this branch): 384-dim embedding index
    (fake/local ONNX embedder + serial save-time queue), note_links +
    semantic_edges tables, graph assembly (extracted/structural/semantic
    + Louvain, group-capped structural, filters), merged view with live
    re-resolution, hybrid FTS+vector search via one `searchNotes()` with
    RRF, reindex script + boot embedding catch-up. 41 tests green; e2e
    verified (graph + highlighted search snippets on live server).
- **Current task**: sub-project 5 — Hocuspocus Yjs relay (same process),
  per-op live permission checks, server kick on revocation, presence
  scoping, Yjs-doc ↔ OKF-file persistence through notes/store.ts
- **Next step**: plan `docs/superpowers/plans/2026-07-17-realtime-collab.md`
- **Open PRs**: none
- **Open issues**: #9 (cli-visualizer — deferred, assigned @snavid-dev)
- **UI phase**: not started, blocked on backend + page-by-page UI design
