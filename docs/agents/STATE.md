# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: BACKEND COMPLETE (again) — codebase mapping (8+9) shipped
- **Done**:
  - Original 7 sub-projects + admin dashboard + MFA (PRs #16-#34)
  - Sub-project 8 Repository ingestion & permissions (PR #37/#39):
    Repository entity, 3 ingestion methods (git shallow-clone+webhook/
    poll, local chokidar watch, agent/CLI push), AES-256-GCM credentials
  - Sub-project 9 Code graph & unified search/MCP (this branch, plan
    `docs/superpowers/plans/2026-07-18-code-graph-integration.md`, all
    8 tasks done): web-tree-sitter extraction (import + "contains"
    symbol edges; TS/JS/Python/Go), buildGraph+searchNotes made
    polymorphic over vaults+repositories, semanticEdges migrated to a
    polymorphic (type,id) shape so notes↔code semantic edges are real
    (not just asserted), repo: cross-type wikilinks, repository-scoped
    + merged routes, MCP repository tools + hard-scoped connection type.
    123 tests green; e2e verified live (incl. a real ordering-race bug
    found via smoke test and fixed: extraction now waits for the whole
    sync batch to persist before running, not per-file).
- **Current task**: none in flight — backend done again.
- **Next step (UI phase)**: design the page-by-page UI structure with
  the owner, then build `client/` per `docs/agents/implementation.md`.
- **Known deferred**: cross-file call-graph resolution (symbol
  references, not just declarations), symbol-level embeddings, cloud
  backups, cli-visualizer (#9, assigned), Leiden upgrade.
- **Open issues**: #9 (deferred, assigned)
