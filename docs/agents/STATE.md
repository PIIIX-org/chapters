# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: Backend — sub-project 6 (MCP integration)
- **Spec**: `docs/superpowers/specs/2026-07-12-mcp-integration-design.md`
- **Done**:
  - Scaffold (#16); 1 Auth (#18); 2 Notes (#21); 3+4 Graph+Search (#23)
  - Sub-project 5 Realtime collab (this branch): Hocuspocus 4 on
    COLLAB_PORT (same process), session-token auth requiring edit,
    per-message live permission re-check, event-driven kick bus wired
    into share/team/admin mutations, debounced persistence through
    notes/store (shared OKF validation), SSE live view for read-only
    users (no awareness/identity exposure). 46 tests green.
- **Current task**: sub-project 6 — MCP server (TS SDK) over HTTP:
  read/write/search/graph tools via resolveMcpToken, writes through
  hocuspocus openDirectConnection, audit trail + revert + hard purge,
  scope enforcement (vault-scoped ≠ account surfaces), per-connection
  rate limiting, bulk-op confirmation
- **Next step**: plan `docs/superpowers/plans/2026-07-17-mcp-integration.md`
- **Open PRs**: none
- **Open issues**: #9 (cli-visualizer — deferred, assigned @snavid-dev)
- **UI phase**: not started, blocked on backend + page-by-page UI design
