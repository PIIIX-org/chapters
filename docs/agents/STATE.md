# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: Backend — sub-projects 3+4 (Graph engine + Search)
- **Specs**: `2026-07-09-graph-engine-design.md`, `2026-07-11-search-design.md`
- **Done**:
  - Scaffold (PR #16); Sub-project 1 Auth & Vault/Sharing (PR #18)
  - Sub-project 2 Editor backend (this branch): OKF validation
    (`notes/okf.ts`), disk+DB single write path (`notes/store.ts`),
    notes CRUD/tree/rename REST, soft-delete trash + restore, per-type
    index.md regeneration. 34 tests green; e2e verified on disk.
- **Current task**: sub-projects 3+4 (shared embedding index → edges +
  Louvain communities + graph endpoints; Postgres FTS + hybrid search)
- **Next step**: plan `docs/superpowers/plans/2026-07-17-graph-search.md`
- **Open PRs**: none
- **Open issues**: #9 (cli-visualizer — deferred, assigned @snavid-dev)
- **UI phase**: not started, blocked on backend + page-by-page UI design
