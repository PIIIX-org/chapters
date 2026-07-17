# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: Backend — cross-cutting specs (admin dashboard, MFA)
- **Specs**: `2026-07-15-admin-oversight-dashboard-design.md`, `2026-07-15-mfa-design.md`
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
- **Done also**: sub-project 7 export (this branch): per-note/vault zip
  export (edit+ only, trash excluded, manifest sidecar), sessionless
  expiring/revocable share links, multipart import (new vault, shared
  validation, email share re-matching + unmatched report), admin
  full-instance backup (vault bundles + account dump). 57 tests green.
- **Current task**: admin dashboard endpoints (instance stats, vault/
  team oversight metadata-only, force-revoke) then MFA (TOTP opt-in +
  admin-mandatable). After that: backend done → UI phase.
- **Open PRs**: none
- **Open issues**: #9 (cli-visualizer — deferred, assigned @snavid-dev)
