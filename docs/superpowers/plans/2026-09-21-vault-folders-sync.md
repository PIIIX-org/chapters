# Vault Organization Cloud Sync & Storage Preference Plan

**Date**: 2026-09-21  
**Issue**: [#185](https://github.com/PIIIX-org/chapters/issues/185)  
**Branch**: `feat/vault-groups-cloud-sync`  

---

## Background & Problem

In Chapters, vault organization (folders, groups, folder colors, vault accent colors, and favorites) is currently managed entirely on the client in `useVaultFolders.ts` using `localStorage` (`chapters_vault_folders`, `chapters_folder_colors`, `chapters_vault_colors`, `chapters_vault_favorites`).

Because there is no server-side persistence:
1. Folders and groups created on one device (e.g. office Mac) are not available when accessing Chapters on another device (e.g. Windows laptop).
2. Users have requested the ability to store vault groups/folders on the server, while also retaining the explicit choice between **Local (browser-only)** and **Online (account/cloud-synced)** storage.

---

## Solution Design

### 1. Database Schema (`server/src/db/schema.ts`)
Introduce table `user_vault_preferences`:
- `userId`: `uuid`, primary key, foreign key references `users.id` with `onDelete: 'cascade'`.
- `storageMode`: `text`, `'online' | 'local'`, defaults to `'online'`.
- `folders`: `jsonb`, Record<string, string> (vaultId -> folderName), defaults to `{}`.
- `folderColors`: `jsonb`, Record<string, string> (folderName -> color), defaults to `{}`.
- `vaultColors`: `jsonb`, Record<string, string> (vaultId -> color), defaults to `{}`.
- `favorites`: `jsonb`, Record<string, boolean> (vaultId -> true), defaults to `{}`.
- `updatedAt`: `timestamp with time zone`, defaults to `now()`.

Generate migration via `drizzle-kit` (`server/drizzle/0015_user_vault_preferences.sql`) and register in `server/drizzle/meta/_journal.json`.

### 2. Backend Routes (`server/src/vaults/routes.ts` or `server/src/auth/account-routes.ts`)
Expose authenticated endpoints:
- `GET /me/vault-preferences`:
  - Returns `{ storageMode, folders, folderColors, vaultColors, favorites }`. If no record exists, returns defaults with `storageMode: 'online'`.
- `PUT /me/vault-preferences`:
  - Validates and upserts preferences for `req.user!.id`.
  - Supports partial updates for `{ storageMode?, folders?, folderColors?, vaultColors?, favorites? }`.
  - Returns updated preferences.

### 3. MCP Tools (`server/src/mcp/server.ts`)
- Add `get_vault_preferences` and `update_vault_preferences` MCP tools for account-scoped connections, enabling agents to inspect and organize vault structures.

### 4. Client API & Hook (`client/src/api/vaults.ts` & `client/src/components/vault/useVaultFolders.ts`)
- Define `VaultUserPreferences` in `client/src/api/vaults.ts`.
- Update `useVaultFolders`:
  - Initializes instantly from local storage for fast render.
  - Tracks `storageMode` (`'online' | 'local'`).
  - When `storageMode === 'online'`:
    - On mount, fetches server preferences via `getVaultUserPreferences()`.
    - Merges remote data with local data (uploading any existing local folders so user data is never lost).
    - Debounces server updates via `PUT /api/me/vault-preferences` on mutations.
  - When `storageMode === 'local'`:
    - Skips server sync; keeps everything strictly in browser `localStorage`.
  - Provides `setStorageMode(mode)` and `syncLocalToRemote()` actions.

### 5. UI Controls (`client/src/pages/VaultsPage.tsx` & `client/src/components/vault/VaultFolderDialog.tsx`)
- On the Vaults page toolbar, provide a storage mode indicator and switcher (e.g. Cloud Synced vs Local Only).
- In `VaultFolderDialog`, show the storage status and offer a quick toggle/link so the user knows where their folder configuration is stored.

### 6. Mock Server & Testing
- Update `client/mock/server.mjs` to implement `/me/vault-preferences`.
- Add server tests (`server/test/vault-preferences.test.ts`) validating GET, PUT, upsert, unauthenticated 401, and schema validation.
- Add frontend tests for `useVaultFolders` and storage mode toggling.

---

## Tasks

- [ ] **Task 1**: Update Drizzle schema `server/src/db/schema.ts` and generate migration `0015_user_vault_preferences.sql`.
- [ ] **Task 2**: Implement `GET /me/vault-preferences` and `PUT /me/vault-preferences` endpoints in `server/src/auth/account-routes.ts`.
- [ ] **Task 3**: Add MCP tools `get_vault_preferences` and `update_vault_preferences` in `server/src/mcp/server.ts`.
- [ ] **Task 4**: Add mock server endpoints in `client/mock/server.mjs`.
- [ ] **Task 5**: Update `client/src/api/vaults.ts` and `client/src/components/vault/useVaultFolders.ts` with online/local toggle and sync.
- [ ] **Task 6**: Update `client/src/pages/VaultsPage.tsx` and `VaultFolderDialog.tsx` with storage mode UI.
- [ ] **Task 7**: Write backend tests and client tests.
- [ ] **Task 8**: Typecheck, lint, and run tests locally.
- [ ] **Task 9**: Commit changes with author `Taha-Mahmoodi <85902429+Taha-Mahmoodi@users.noreply.github.com>`, push branch, and open PR targeting `dev`.
