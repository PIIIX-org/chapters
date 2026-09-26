# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Status**: Post-audit MVP stabilization COMPLETE (PRs #286–#293 merged into `dev`).
  - #286 (Fixes #278): Note rename frontmatter type sync and disk rollback.
  - #287 (Fixes #279): REST note updates and revision reverts write through live Yjs CRDT docs.
  - #288 (Fixes #280): Admin user reactivation endpoint `POST /api/admin/users/:id/reactivate`, security event, client API, and UI roster action.
  - #289 (Fixes #281): Vault-wide wikilink refactoring on note rename via `writeThroughCollab`.
  - #290 (Fixes #284): Bulk `POST /api/notifications/read-all` endpoint, client API, and UI action.
  - #291 (Fixes #282): Visual revision diff preview modal with LCS line diffing before revert.
  - #292 (Fixes #283): Incoming backlinks panel in note inspector with candidate target matching.
  - #293 (Fixes #285): Responsive mobile drawer layout, auto-collapse, and mutual exclusivity.
- **Previous Phases**: UI Redesign (#206), OKF v0.2 alignment (#209–#213), Fullscreen Floating Shell (#218–#239), and Production Hardening (#244–#276: zero vulnerabilities, pino logger, error boundaries, health check, backoff retries, exact seq scan for deterministic semantic edge recompute).
- **Architecture Traps**:
  - `prod` == `dev` needs Taha's explicit OK. PRs target `dev` directly, never stacked.
  - 1 container + 1 Postgres per customer. Control plane in separate private repo.
  - Collab is a person, no autosave PUT (CRDT is the note). Viewer read-only forever.
  - Exact seq scan for semantic edge recompute (#123). Mutation-verify every test.
- **Suite**: 1,140 automated tests (820 client, 320 server across 171 test files), 100% passing. Zero open bugs.
- **Deferred**: cloud backups (#260), cli-visualizer (#9, assigned), symbol embeddings (#262), partial restore (#261), per-type notification prefs (#263).
- **Decided against (do NOT re-open)**: Leiden (#265), graph DB (#268), GraphRAG (#267), cross-file calls (#266).
- **Open issues**: #9 (assigned).
