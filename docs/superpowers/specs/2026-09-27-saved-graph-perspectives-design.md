# Specification: Saved Graph Perspectives & Filter Presets (§4.2)

**Date**: 2026-09-27  
**Status**: Implemented  
**Reference**: Market Intelligence Report §4.2  

---

## 1. Overview & Problem Statement

Global knowledge graphs can become visually overwhelming when team codebases and vaults grow past hundreds of nodes. Engineers and architects require rapid, repeatable access to scoped subgraphs aligned with their domain responsibilities:
- **Architecture & ADRs**: Notes of type `adr`, `spec`, `rfc` and tags `architecture`.
- **Security & Auth Surface**: Notes tagged `security`, `auth`.
- **Recent Evolutions**: Nodes modified within the last 30 days.
- **Custom Domain Slices**: Bespoke filter combinations saved by teams and shared collaboratively.

Previously, filtering required manual checkbox and date range toggling per session, and filter settings could not be saved, named, shared with team members, or queried via Model Context Protocol (MCP).

---

## 2. Architecture & Design

### 2.1 Database Schema (`graph_perspectives`)
Migration `0017_nervous_jack_flag.sql`:
- `id`: UUID Primary Key (`gen_random_uuid()`)
- `vault_id`: UUID nullable, foreign key to `vaults.id` (`onDelete: cascade`). `NULL` denotes a merged/global graph perspective.
- `user_id`: UUID not null, foreign key to `users.id` (`onDelete: cascade`).
- `name`: TEXT not null.
- `filters`: JSONB not null default `'{}'` (`types`, `tags`, `since`, `until`, `colorMode`).
- `is_shared`: BOOLEAN not null default `true`.
- `created_at`, `updated_at`: TIMESTAMPTZ default `now()`.
- Indexes on `vault_id` and `user_id`.

### 2.2 REST API Routes (`server/src/graph/routes.ts`)
- `GET /api/graph/perspectives?vaultId=...`:
  - Returns perspectives accessible to the authenticated user.
  - Scoped by vault (or merged if omitted), checking read access.
  - Filters by creator (`user_id = auth.user.id`) or team-shared (`is_shared = true`).
- `POST /api/graph/perspectives`:
  - Validates name and vault access.
  - Inserts and returns 201 with created perspective.
- `DELETE /api/graph/perspectives/:id`:
  - Enforces authorization: only creator or vault owner can delete.
  - Returns 200 `{ ok: true }`.

### 2.3 Model Context Protocol (MCP) Tools (`server/src/mcp/server.ts`)
Three first-class tools registered with Zod validation and access controls:
1. `list_graph_perspectives`: Lists perspectives for a vault or merged graph.
2. `save_graph_perspective`: Saves a scoped perspective with filter criteria.
3. `delete_graph_perspective`: Deletes a saved perspective by ID.

### 2.4 Client UI (`client/src/components/graph/GraphFilters.tsx`)
- Integrated into the graph Inspector's Filters section.
- Native `<select>` combobox with built-in presets:
  - **All Nodes**: Resets all active filters.
  - **Architecture & Specs**: Types `adr`, `spec`, `rfc`; tag `architecture`.
  - **Security & Auth**: Tags `security`, `auth`.
  - **Recent (30 Days)**: Dynamic ISO date calculation.
  - **Saved Perspectives**: Dynamically fetched and rendered.
- **Save View Form**: Inline accessible form with perspective name input, "Share with team" checkbox, and Save/Cancel actions.
- **Delete Action**: Instant deletion for custom-selected perspectives.
- **Accessibility & Keyboard**: Fully operable via keyboard alone with 0 axe violations (`expectNoA11yViolations`).

---

## 3. Verification & Metrics
- **Tests**: 1,253 automated tests passing (871 client, 382 server across 186 test files).
- **Typecheck**: Zero errors across workspace (`tsc --noEmit`).
- **Lint**: Zero warnings or errors (`eslint .`).
- **Accessibility**: 100% compliant with strict Axe automated audits.
