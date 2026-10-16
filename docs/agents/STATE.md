# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Updated**: 2026-10-15 (Elara AI-performance study, rounds 1 and 2). Product is **Elara**; the repo keeps the name `chapters`. Study: Elara vault notes `audit/2026-10-14-ai-performance-study` (round 1) and its round-2 follow-up.
- **Promoted to `prod` in #407 (2026-10-15, merge `111e3f1`, image published)**. The hosted instance runs these only after a redeploy (`docker compose pull && docker compose up -d`). The study's fixes:
  - #400 frontmatter fence must be a whole `---` line; writes that don't survive serialize→parse are refused (400).
  - #405 a minified/oversized file can't stall extraction; boot re-enqueues files lost to a restart; `repository_status.filesPendingExtraction` (fixes #404).
  - #398 import edges resolve `.js/.jsx/.mjs/.cjs` → TS sources and `@/` → package `src`; boot backfills unresolved import rows.
  - #402 per-note write lock and unique temp files (fixes #401). Lost read-then-append updates remain (writes are ordered, not merged).
  - #399 (control arm) closed, not merged. On the first start after the redeploy, the extraction catch-up and the import backfill run automatically.
- **Open issues**: #403 (MCP/REST edits attributed to `collab`/null when the relay runs), #408 (`edit_note` replaces the whole body), #409 (backup restore), #410 (webhook stops polling), #411 (`note_history` unbounded), #377 (offline-first sync), #261, #263 (deferred), #9 (assigned).
- **Known open defects** from the round-2 study (issue numbers where filed):
  - `edit_note` replaces the whole body: an agent edit deletes a user's in-flight typing; no `append`/patch or `ifRevision` (#408).
  - Crash safety: DB row can get ahead of the file; `.crdt` reload can duplicate a document after a crash; collab edits closed within the 2 s save delay are lost.
  - Backup restore crashes on trashed vaults and repo-scoped tokens; loses attachments, trash, revisions, MFA; backups are mode 644 (#409).
  - Size: collab socket accepts up to 100 MiB; `note_history` returns full content unpaginated and can hang or crash the app (#411).
  - Logout leaves the collab socket connected.
  - Ingestion: `export const` arrow functions and `.mts` not extracted; one global extraction queue; a webhook stops polling for that repo (#410).
  - MCP: 6 tools ignore the token pin (`find_symbols`, 3 perspective tools, 2 preference tools); no line-range `read_file`, no path filter on `browse_repository`, no `limit` on `graph`; `graph` can't apply perspectives.
  - Audit checks structure only (scored a vault with wrong facts 100/100). Bare `[[name]]` links break on rename.
  - Search: English-only embedder; Persian notes get meaningless semantic edges; no Arabic-script normalization.
  - Benchmarks (TP-01..TP-15, `docs/benchmarks/`) retracted: runners never merged, run against prod, impossible numbers. Replaced by the premise benchmark (#570/#572, `benchmarks/README.md`): `bench` ×3 + `bench-gate` jobs in the lab workflow, Elara MCP vs ripgrep + ranged reads on 5 pinned repos, gate on the median hit@5 and tokens-to-gold against `benchmarks/baseline.json` (suite changes and a lowered baseline need owner labels). Today: Elara finds the right file more often on 3 of 5 repos but, where both reach the evidence, grep is 2-5x cheaper (whole-file `read_file`). Search ties are unordered (#623).
- **Previous work**: UI redesign (#206), OKF v0.2 (#209–#213), shell (#218–#239), hardening (#244–#277), MCP prompts and perspectives, mobile cards (2026-10-09), note repair (#391/#395), git credential scrub (#383/#394).
- **Architecture Traps**:
  - `prod` == `dev` needs Taha's explicit OK. PRs target `dev` directly, never stacked.
  - 1 container + 1 Postgres per customer. Control plane in separate private repo.
  - Collab is a person, no autosave PUT (CRDT is the note). Viewer read-only forever.
  - Exact seq scan for semantic edge recompute (#123). Mutation-verify every test.
  - MCP is Streamable HTTP only (`/mcp`, `/elara/mcp`); no stdio. Hosted at `chapters.piiix.org`; `elara.piiix.org` is not live.
- **Suite**: server + client Vitest suites run in CI (`checks`) on every PR. `server/test/mcp-secret-scan.test.ts` (#577) calls every MCP tool and prompt against seeded secrets: a new tool fails CI until it has a fixture step there. A `fix:` PR to `dev` also runs `fails-before` (#575): its changed tests must fail on the base commit, or the PR carries label `no-fails-before` + a `Fails-before: n/a because ...` line (not a required check yet; item 177). Every PR to `dev` or `prod` runs `pr-evidence` (#579): the body needs an Evidence section with at least one link into the repo (template `.github/pull_request_template.md`), and claims need a link next to them; rules in `github-workflow.md` (not a required check yet; item 177). The **Elara lab** (#576, `docs/agents/lab.md`) builds the commit with docker compose and runs the integration tests (collab relay, store, disk, MCP): fast tier on PRs to `dev` that change the image inputs (`server/**`, `client/**`, root manifests and lockfile, Dockerfile, compose) or `lab/**`; full tier nightly and on PRs to `prod`. Its gate fails on a failed or inconclusive check outside `lab/known-defects.json` or a listed defect that no longer shows; a fix removes its entry (not a required check yet; item 177).
- **Deferred**: cli-visualizer (#9, assigned), partial restore (#261), per-type notification prefs (#263).
- **Decided against (do NOT re-open)**: WebMCP browser standard (adr-001), Leiden (#265), graph DB (#268), GraphRAG (#267), cross-file calls (#266).
