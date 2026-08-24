# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE, executing `docs/superpowers/specs/2026-08-22-remaining-ui-design.md`
  (10 locked decisions, 7 units). **PRs target `dev` directly, never stacked.**
  Promotion `dev → prod` needs Taha's explicit OK each time.
- **Backend**: complete, plus five additions the UI spec surfaced. Graph plan
  (#91/#92/#93) done — semantic edges stored **directed**, purge paths clear them
  explicitly (polymorphic, no FK); `pnpm profile-graph` ≈500ms at 10k notes,
  Louvain NOT the bottleneck.
- **Units 1 and 2 shipped**:
  - **1a** community aggregation + `community=<n>` drill-down, `GET
    .../graph-preference`, vault soft delete + owner-only purge.
  - **1b** app shell, `/` as graph Home (lazy chunk), vault lifecycle,
    **cold-start vault creation** (app was unusable from a fresh signup),
    `GET /vaults/trash` + restore, axe gate, bundle-budget CI test.
  - **1c** graph canvas — Canvas 2D + `d3-force` + 53-line pan/pinch, chosen by
    measured probe (83fps @2000 nodes, 7KB lazy; SVG and cytoscape FAILED).
    Clustering, drill-down, ink-fade, physics controls. **Louvain is seeded** —
    drill-down addresses communities by number, so ids must be stable.
  - **1d/1e** ⌘K keyboard nav, scope toggle, filters, commands, code results;
    notification bell + drawer.
  - **2** vault settings **modal stack** (sharing, mergeable, vault-scoped MCP +
    one-time reveal, export links), `/team`, `GET /users/lookup` (exact-match,
    non-enumerable), grantee emails on shares, `GET /teams/:id/stats` (aggregates
    only, scoped by `listAccessibleVaults` — privacy enforced server-side).
- **Current task**: none. Unit 2 merged as PR #107.
- **Next**: unit 3 Admin (approval queue, user management, oversight, backup
  download). Then 4 settings+MFA · 5 trash/history/import · 6 collaboration
  (yjs) · 7 repositories.
- **Still no client UI**: collaboration, repositories, admin, settings/MFA,
  trash/history/import. MCP needs none — AI clients consume it directly.
- **Test-that-cannot-fail has appeared SEVEN times**, always a fixture too small
  or uniform to tell working from broken. Mutation-verify every new test.
- **Known deferred**: cloud backups, cli-visualizer (#9), symbol embeddings,
  partial restore, single-process arch. **Decided against 2026-08-22, do not
  re-open**: Leiden, a graph database, GraphRAG summaries, cross-file calls.
- **Open issues**: #9; #66 (updateNote race); #101 (graph query-param
  inconsistencies, dead overload, dangling notifications on purge).
