# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Updated**: 2026-10-14 (Elara AI-performance study, rounds 1 and 2). Product is **Elara**; the repo keeps the name `chapters`. Study: Elara vault notes `audit/2026-10-14-ai-performance-study` (round 1) and its round-2 follow-up.
- **Merged to `dev` (2026-10-15, from the study)**:
  - #400 frontmatter fence must be a whole `---` line; writes that don't survive serialize→parse are refused (400).
  - #405 a minified/oversized file can't stall extraction; boot re-enqueues files lost to a restart; `repository_status.filesPendingExtraction` (fixes #404).
  - #398 import edges resolve `.js/.jsx/.mjs/.cjs` → TS sources and `@/` → package `src`; boot backfills unresolved import rows.
  - #402 per-note write lock and unique temp files (fixes #401). Lost read-then-append updates remain (writes are ordered, not merged).
  - #399 (control arm) closed, not merged. Production gets these on the next promotion; the extraction catch-up and import backfill run automatically at server start.
- **Open issues**: #403 (MCP/REST edits attributed to `collab`/null when the relay runs), #377 (offline-first sync), #261, #263 (deferred), #9 (assigned).
- **Known open defects** (from the round-2 study; not yet filed as issues unless noted):
  - `edit_note` replaces the whole body: an agent edit deletes a user's in-flight typing; no `append`/patch or `ifRevision`.
  - Crash safety: DB row can get ahead of the file; `.crdt` reload can duplicate a document after a crash; collab edits closed within the 2 s save delay are lost.
  - Backup restore crashes on trashed vaults and repo-scoped tokens; loses attachments, trash, revisions, MFA; backups are mode 644.
  - Size: collab socket accepts up to 100 MiB; `note_history` returns full content unpaginated and can hang or crash the app.
  - Logout leaves the collab socket connected.
  - Ingestion: `export const` arrow functions and `.mts` not extracted; one global extraction queue; a webhook stops polling for that repo (`scheduler.ts`).
  - MCP: 6 tools ignore the token pin (`find_symbols`, 3 perspective tools, 2 preference tools); no line-range `read_file`, no path filter on `browse_repository`, no `limit` on `graph`; `graph` can't apply perspectives.
  - Audit checks structure only (scored a vault with wrong facts 100/100). Bare `[[name]]` links break on rename.
  - Search: English-only embedder; Persian notes get meaningless semantic edges; no Arabic-script normalization.
  - Benchmarks (TP-01..TP-15, `docs/benchmarks/`) retracted: runners never merged, run against prod, impossible numbers.
- **Previous work**: UI redesign (#206), OKF v0.2 (#209–#213), shell (#218–#239), hardening (#244–#277), MCP prompts and perspectives, mobile cards (2026-10-09), note repair (#391/#395), git credential scrub (#383/#394).
- **Architecture Traps**:
  - `prod` == `dev` needs Taha's explicit OK. PRs target `dev` directly, never stacked.
  - 1 container + 1 Postgres per customer. Control plane in separate private repo.
  - Collab is a person, no autosave PUT (CRDT is the note). Viewer read-only forever.
  - Exact seq scan for semantic edge recompute (#123). Mutation-verify every test.
  - MCP is Streamable HTTP only (`/mcp`, `/elara/mcp`); no stdio. Hosted at `chapters.piiix.org`; `elara.piiix.org` is not live.
- **Suite**: server + client Vitest suites run in CI (`checks`) on every PR.
- **Deferred**: cli-visualizer (#9, assigned), partial restore (#261), per-type notification prefs (#263).
- **Decided against (do NOT re-open)**: WebMCP browser standard (adr-001), Leiden (#265), graph DB (#268), GraphRAG (#267), cross-file calls (#266).
