# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE, executing `docs/superpowers/specs/2026-08-22-remaining-ui-design.md`
  (10 locked decisions, 7 units). **PRs target `dev` directly, never stacked.**
  Promotion `dev → prod` needs Taha's explicit OK each time.
- **Backend**: complete + seven UI-driven additions. `pnpm profile-graph`
  ≈500ms at 10k notes, **Louvain NOT the bottleneck**. Semantic edges stored
  **directed**; purge paths clear them explicitly (no FK).
- **Units 1–3 shipped** (detail in README + git log):
  - **1** graph Home (Canvas 2D + `d3-force`; SVG and cytoscape FAILED the
    probe), community aggregation + drill-down, shell, vault lifecycle, ⌘K,
    notifications. **Louvain is seeded** — drill-down addresses communities by
    number, so ids must stay stable.
  - **2** vault settings **modal stack** (sharing, mergeable, vault MCP,
    export), `/team`, `GET /users/lookup` (exact-match, non-enumerable),
    `GET /teams/:id/stats` (aggregates only, scoped server-side).
  - **3** `/admin`, admins only and gated *before* any query fires: approval
    queue (shows whether the pending email is verified), user roster
    (promote/deactivate, never yourself), vault+team oversight with owner
    reassignment, access view (every share + MCP connection, force-revocable),
    paginated security log + audit trail, stats, backup download. Metadata only
    — no endpoint behind it serves note text. Added
    `GET /admin/mcp-connections`, `emailVerifiedAt` on `GET /admin/users`.
    Signup/verify state the approval wait; **login stays generic on purpose**
    (enumeration) — do not "fix" it.
- **Current task**: none. Unit 3 open as a PR off `dev`. **Next**: 4
  settings+MFA · 5 trash/history/import · 6 collab (yjs) · 7 repositories.
- **Still no client UI**: collaboration, repositories, settings/MFA, trash/
  history/import. MCP needs none — AI clients consume it directly.
- **`apiFetch` declared JSON with no body** → every bodyless DELETE/POST 400'd
  in a real browser across all three units; tests stub `fetch`, so none caught
  it (#110, fixed). Click a unit in a browser before calling it done.
- **Test-that-cannot-fail: SEVEN times**, always a fixture too uniform to tell
  working from broken. Mutation-verify every new test.
- **Deferred**: cloud backups, cli-visualizer (#9), symbol embeddings, partial
  restore, single-process arch. **Decided against 2026-08-22, do not re-open**:
  Leiden, a graph DB, GraphRAG summaries, cross-file calls.
- **Open issues**: #9; #66 (updateNote race); #101 (graph query-param
  inconsistencies, dead overload, dangling notifications on purge).
