# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: Backend — sub-project 9 (Code graph & unified search/MCP)
- **Spec**: `docs/superpowers/specs/2026-07-18-code-graph-integration-design.md`
- **Done**:
  - Scaffold (#16); 1 Auth (#18); 2 Notes (#21); 3+4 Graph+Search (#23);
    5 Realtime collab (#25); 6 MCP (#28); 7 Export (#30); Admin
    dashboard (#32); MFA (#33); design specs for 8+9 (#35)
  - Sub-project 8 Repository ingestion & permissions (this branch, plan
    `docs/superpowers/plans/2026-07-18-repository-ingestion.md`, all 11
    tasks done): Repository/RepositoryShare/RepositoryGraphPreference/
    RepositoryFile/RepositorySyncToken schema; owner/viewer access
    resolution; CRUD+shares+graph-pref+files routes; AES-256-GCM
    credential encryption; three ingestion methods (agent/CLI push,
    chokidar local-path watch, git shallow-clone) all converging on one
    sync/diff/hard-delete function; GitHub-style HMAC webhook receiver;
    polling fallback scheduler. 95 tests green; e2e verified live
    (push→sync→list against a real server).
- **Current task**: sub-project 9 — tree-sitter extraction (import +
  "contains" symbol edges), `buildGraph`/search made polymorphic over
  vaults+repositories, `repo:` wikilinks, MCP repository tools + scope
- **Next step**: plan `docs/superpowers/plans/2026-07-18-code-graph-integration.md`
- **Open PRs**: none
- **Open issues**: #9 (cli-visualizer — deferred, assigned @snavid-dev)
- **UI phase**: not started, blocked on backend + page-by-page UI design
