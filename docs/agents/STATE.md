# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Status**: Local ego graph feature implemented; post-audit MVP stabilization COMPLETE.
  - #286–#293: Rename type sync, CRDT write-through, admin reactivation, wikilink refactoring, bulk mark-all-read notifications, revision diff modal, incoming backlinks, responsive mobile shell.
  - Local Ego Graph: 1–2 hops local network in Note Inspector with SVG layout, depth toggle, relation pills, and accessible keyboard roster.
- **Previous Phases**: UI Redesign (#206), OKF v0.2 alignment (#209–#213), Fullscreen Floating Shell (#218–#239), and Production Hardening (#244–#276).
- **Architecture Traps**:
  - `prod` == `dev` needs Taha's explicit OK. PRs target `dev` directly, never stacked.
  - 1 container + 1 Postgres per customer. Control plane in separate private repo.
  - Collab is a person, no autosave PUT (CRDT is the note). Viewer read-only forever.
  - Exact seq scan for semantic edge recompute (#123). Mutation-verify every test.
- **Suite**: 1,146 automated tests (826 client, 320 server across 172 test files), 100% passing. Zero open bugs.
- **Deferred**: cloud backups (#260), cli-visualizer (#9, assigned), symbol embeddings (#262), partial restore (#261), per-type notification prefs (#263).
- **Decided against (do NOT re-open)**: Leiden (#265), graph DB (#268), GraphRAG (#267), cross-file calls (#266).
- **Open issues**: #9 (assigned).
