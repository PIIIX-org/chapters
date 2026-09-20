# Stuck Sync Recovery & Orphaned State Reconciliation Plan

**Date**: 2026-09-21  
**Issue**: [#182](https://github.com/PIIIX-org/chapters/issues/182)  
**Branch**: `fix/reconcile-stuck-repo-sync`  

---

## Background & Problem

When a repository sync is interrupted (server restart, container redeploy, crash, unhandled rejection during tree-sitter or ONNX embeddings), the row in PostgreSQL remains in `syncStatus: 'syncing'`.

Because:
1. `POST /api/repositories/:id/sync` checks `ne(repositories.syncStatus, 'syncing')` (returning 409 Conflict),
2. The MCP tool `sync_repository` rejects with `Error: a sync is already running`,
3. The polling fallback scheduler explicitly skips rows where `syncStatus == 'syncing'`,
4. The server lacks a startup reconciliation pass,

the repository becomes permanently locked in `'syncing'` until direct database intervention or manual repository deletion.

## Tasks

- [ ] **Task 1**: Implement `reconcileOrphanedSyncs()` in `server/src/repositories/scheduler.ts` to reset stranded `'syncing'` rows on startup.
- [ ] **Task 2**: Wire `reconcileOrphanedSyncs()` into `server/src/index.ts` boot sequence after migrations.
- [ ] **Task 3**: Add `timeout: { block: 300_000 }` to `simpleGit` in `server/src/repositories/git-sync.ts`.
- [ ] **Task 4**: Support `force?: boolean` in `POST /repositories/:id/sync` (`routes.ts`) and `sync_repository` MCP tool (`mcp/server.ts`).
- [ ] **Task 5**: Add `/repositories/:id/sync` mock handler to `client/mock/server.mjs`.
- [ ] **Task 6**: Add unit & integration tests covering startup reconciliation and forced sync claim.
- [ ] **Task 7**: Commit, push branch, open PR on `dev` referencing #182, and verify CI.
