# Post-PR #305 Codebase Bug Audit & Resolution Report

**Date**: 2026-09-27  
**Scope**: Full-codebase audit across client, server, and MCP interfaces following the completion of Saved Graph Perspectives & Filter Presets (§4.2, PR #305) and MCP Prompts Suite (PR #304).  
**Outcome**: 3 root-cause bugs identified, patched, and verified with regression tests. Full automated test suite increased to 1,257 tests (872 client, 385 server across 186 test files), 100% green.

---

## 1. Bugs Discovered & Resolved

### Bug 1 (High): Navigation 404 on Code Node Links in Graph & Palette
- **Symptom**: Clicking on code nodes in the concept pathfinder explorer (`GraphPathfinder.tsx`) or selecting code symbols in the ⌘K Search palette (`SearchOverlay.tsx`) navigated to `/repos/:id/tree/:path`, which hit the catch-all `NotFoundPage` (404).
- **Root Cause**: The client router in `client/src/router.tsx` registered the repository viewer route at `/repos/:id/files/*` with a splat param, but `GraphPathfinder.tsx` and `SearchOverlay.tsx` constructed links using `/tree/`.
- **Resolution**:
  1. Updated `GraphPathfinder.tsx` and `SearchOverlay.tsx` to generate link targets at `/repos/${containerId}/files/${path}`.
  2. Added route alias `{ path: '/repos/:id/tree/*', element: lazyPage(<RepositoryPage />) }` in `client/src/router.tsx` for backwards-compatibility.
  3. Added assertions in `GraphPathfinder.test.tsx` and updated `SearchOverlay.test.tsx`.

### Bug 2 (Medium): PostgreSQL 22P02 Syntax Crash on Malformed UUID Parameters
- **Symptom**: Calling endpoints with non-UUID parameters (e.g. `DELETE /api/graph/perspectives/:id` with a non-UUID ID, or `/api/vaults/:id` with malformed strings) caused PostgreSQL to throw error `22P02: invalid input syntax for type uuid`, bubbling up as an unhandled 500 Internal Server Error.
- **Root Cause**:
  - `resolveAccess` in `server/src/vaults/permissions.ts` and `resolveRepositoryAccess` in `server/src/repositories/permissions.ts` queried `vaults.id` and `repositories.id` directly without pre-validating UUID strings.
  - `DELETE /api/graph/perspectives/:id` queried `where(eq(graphPerspectives.id, req.params.id))` directly.
  - Fastify lacked a specific handler for Postgres `22P02` errors.
- **Resolution**:
  1. Exported `UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` in `server/src/vaults/permissions.ts` and guarded `resolveAccess` and `resolveRepositoryAccess` to return `null` immediately for non-UUID strings.
  2. Added early UUID validation in `DELETE /api/graph/perspectives/:id`.
  3. Updated the global Fastify error handler in `server/src/app.ts` to catch any unhandled Postgres `22P02` errors and return a clean `404 { error: 'not found' }`.
  4. Added regression tests in `app.test.ts`, `graph-perspectives.test.ts`, and `vaults.test.ts`.

### Bug 3 (Low/Medium): GraphFilters Stale Selection on Vault Switch & Color Mode Leak
- **Symptom**: Switching vaults in the graph view kept the previously selected perspective ID active in the dropdown. When applying a saved perspective that did not specify a `colorMode`, any prior `color` URL search param persisted.
- **Root Cause**: `GraphFilters.tsx` did not adjust `selectedPerspectiveId` when `effectiveVaultId` changed, and `handleSelectPerspective` only called `next.set('color', ...)` without an `else next.delete('color')` branch.
- **Resolution**:
  1. Added React render state adjustment in `GraphFilters.tsx` to reset `selectedPerspectiveId('all')` whenever `effectiveVaultId` changes.
  2. Added `else next.delete('color')` when applying custom perspectives.
  3. Added regression test in `GraphFilters.test.tsx` verifying clean parameter reset.

---

## 2. Verification & Metrics

- **Typecheck**: Zero errors across client and server (`tsc --noEmit`).
- **Linter**: Zero warnings across all workspace files (`eslint .`).
- **Client Test Suite**: 872 tests passing (133 test files), 0 a11y violations (`expectNoA11yViolations`).
- **Server Test Suite**: 385 tests passing (53 test files).
- **Total Tests**: 1,257 automated tests passing 100% across 186 test files.
- **PR**: #306 squash-merged to `dev` (`ea7c938`).
