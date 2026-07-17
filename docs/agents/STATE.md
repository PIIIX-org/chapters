# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: Backend — sub-project 7 (Data export & portability)
- **Spec**: `docs/superpowers/specs/2026-07-15-data-export-portability-design.md`
- **Done**:
  - Scaffold (#16); 1 Auth (#18); 2 Notes (#21); 3+4 Graph+Search (#23);
    5 Realtime collab (#25)
  - Sub-project 6 MCP (this branch): stateless Streamable HTTP /mcp with
    Bearer auth via resolveMcpToken, 10 tools (read/browse/create/edit/
    delete/search/graph/history/revert/list_vaults), scope hard-reject
    for vault tokens on account surfaces, writes through hocuspocus
    direct connection with attributed note_revisions audit trail +
    revert + hard purge endpoints, per-connection rate limit, revert
    notifications. 52 tests green.
- **Current task**: sub-project 7 — per-note/vault export (zip +
  manifest), expiring share links, import with OKF validation + share
  re-matching, full-instance admin backup
- **Next step**: plan `docs/superpowers/plans/2026-07-17-data-export.md`
- **Remaining after that**: admin dashboard endpoints, MFA (TOTP),
  then backend done → UI phase
- **Open PRs**: none
- **Open issues**: #9 (cli-visualizer — deferred, assigned @snavid-dev)
