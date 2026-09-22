# Chapters MCP Tool Reference

This document provides exact parameter details, response structures, and usage examples for all 50 Chapters Model Context Protocol (MCP) tools.

---

## 1. Vault Management

### `list_vaults`
- **Scope**: Account-level only.
- **Parameters**: None.
- **Returns**: Array of vault objects with `id`, `name`, `description`, `mergeable`, `permission`, `createdAt`, `updatedAt`.

### `create_vault`
- **Scope**: Account-level.
- **Parameters**:
  - `name` (string, required): Name of the vault.
  - `description` (string, optional): Vault description.
  - `mergeable` (boolean, optional): Whether this vault can be included in cross-vault merged graphs (default: `true`).
- **Returns**: The created vault object.

### `browse_vault`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault.
  - `path` (string, optional): Directory path within the vault for progressive disclosure (defaults to root `""`).
  - `recursive` (boolean, optional): If `true`, returns all notes recursively across the vault or subdirectory. If `false` (default when `path` is provided), returns progressive disclosure object with `directory`, `subdirectories` (with child counts), direct `notes`, and immediate `indexContent`.
- **Returns**: Array of notes, or when `path` is specified without `recursive: true`: `{ directory: string, subdirectories: [{ name: string, count: number }], notes: [...], indexContent: string | null }`.

### `update_vault`
- **Scope**: Vault or Account (requires owner permission).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `name` (string, optional): New name.
  - `description` (string, optional): New description.
  - `mergeable` (boolean, optional): New mergeable state.
- **Returns**: Updated vault object.

### `get_vault_graph_preference`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
- **Returns**: `{ vaultId: string, include: boolean }`.

### `set_vault_graph_preference`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `include` (boolean, required): Whether to include this vault in your merged graph view.
- **Returns**: `{ vaultId: string, include: boolean }`.

### `delete_vault`
- **Scope**: Vault or Account (owner only).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
- **Returns**: Confirmation message (vault moved to trash).

### `restore_vault`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, required): ID of the trashed vault.
- **Returns**: Restored vault object.

### `purge_vault`
- **Scope**: Vault or Account (owner only, must already be trashed).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault to permanently delete.
- **Returns**: Confirmation message.

### `list_vault_shares`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
- **Returns**: Array of user and team share grants.

### `share_vault`
- **Scope**: Vault or Account (owner only).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `userId` (string, optional): User ID to share with.
  - `teamId` (string, optional): Team ID to share with.
  - `permission` (string, required): `"read"` or `"edit"`.
- **Returns**: Created share object.

### `revoke_vault_share`
- **Scope**: Vault or Account (owner only).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `userId` (string, optional): User ID to revoke from.
  - `teamId` (string, optional): Team ID to revoke from.
- **Returns**: Confirmation message.

---

## 2. Note Operations

### `read_note`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `path` (string, required): Path of the note (e.g., `concepts/architecture.md`).
- **Returns**: `{ path, content, frontmatter, updatedAt, lastRevisionId }`.

### `create_note`
- **Scope**: Vault or Account (requires edit permission).
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault.
  - `path` (string, optional): Unified hierarchical note path (e.g., `domains/auth/session-lifecycle.md` or `specs/crdt.md`, up to 8 directory levels). Must be provided if `type` and `name` are omitted.
  - `type` (string, optional): Note category slug (used with `name` if `path` is omitted).
  - `name` (string, optional): Note slug name (used with `type` if `path` is omitted).
  - `frontmatter` (object, optional): OKF v0.2 frontmatter object (with `title`, `tags`, `timestamp`, `status`, `verified`, `generated`, `sources`, etc.).
  - `body` (string, optional): Markdown note body.
  - `content` (string, optional): Full markdown content with YAML frontmatter.
- **Returns**: Created note metadata.

### `audit_okf_conformance`
- **Scope**: Vault or Account (requires read permission).
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault to audit.
- **Returns**: `{ vaultId: string, totalNotes: number, passed: boolean, score: number, checks: { isoTimestamps: { passed: boolean, failures: [...] }, wikilinks: { passed: boolean, broken: [...] }, repoLinks: { passed: boolean, unresolved: [...] }, progressiveDisclosure: { passed: boolean, missingIndices: [...] }, orphanNotes: { passed: boolean, orphans: [...] } } }`.

### `edit_note`
- **Scope**: Vault or Account (requires edit permission).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `path` (string, required): Path of the note.
  - `content` (string, required): Updated markdown content with YAML frontmatter.
- **Returns**: Updated note metadata and new revision ID.

### `rename_note`
- **Scope**: Vault or Account (requires edit permission).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `oldPath` (string, required): Current note path.
  - `newPath` (string, required): New note path.
- **Returns**: `{ oldPath, newPath }`.

### `delete_note`
- **Scope**: Vault or Account (requires edit permission).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `path` (string, required): Path of the note to move to trash.
- **Returns**: Confirmation message.

### `list_trash`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
- **Returns**: Array of trashed notes with paths and deletion timestamps.

### `restore_note`
- **Scope**: Vault or Account (requires edit permission).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `path` (string, required): Path of the note to restore.
- **Returns**: Restored note object.

### `purge_note`
- **Scope**: Vault or Account (requires edit permission).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `path` (string, required): Path of the note to permanently remove.
- **Returns**: Confirmation message.

### `note_history`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `path` (string, required): Path of the note.
- **Returns**: Array of revisions with `id`, `timestamp`, `authorId`, `authorType` (`"user"` or `"mcp"`), and patch size.

### `revert_note`
- **Scope**: Vault or Account (requires edit permission).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `path` (string, required): Path of the note.
  - `revisionId` (string, required): Revision ID to revert to.
- **Returns**: Reverted note metadata and newly created revision.

### `purge_revision`
- **Scope**: Vault or Account (owner only).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `path` (string, required): Path of the note.
  - `revisionId` (string, required): Revision ID to permanently remove.
- **Returns**: Confirmation message.

---

## 3. Repositories (Codebase Mapping)

### `list_repositories`
- **Scope**: Account-level only.
- **Parameters**: None.
- **Returns**: Array of repositories with `id`, `name`, `type` (`"git"` or `"local"`), `url`, `defaultBranch`, `lastSyncAt`.

### `connect_repository`
- **Scope**: Account-level.
- **Parameters**:
  - `name` (string, required): Repository name.
  - `type` (string, required): `"git"` or `"local"`.
  - `url` (string, optional): Git clone URL.
  - `localPath` (string, optional): Filesystem path for local watch.
- **Returns**: Created repository metadata.

### `browse_repository`
- **Scope**: Repository or Account.
- **Parameters**:
  - `repositoryId` (string, required): ID of the repository.
  - `path` (string, optional): Directory path (defaults to root `""`).
- **Returns**: Array of files and directories.

### `read_file`
- **Scope**: Repository or Account.
- **Parameters**:
  - `repositoryId` (string, required): ID of the repository.
  - `path` (string, required): File path within repository.
- **Returns**: `{ path, content, symbols: [{ name, kind, line, character }] }`.

### `repository_status`
- **Scope**: Repository or Account.
- **Parameters**:
  - `repositoryId` (string, required): ID of the repository.
- **Returns**: `{ status, headCommit, fileCount, symbolCount, lastSyncAt }`.

### `sync_repository`
- **Scope**: Repository or Account.
- **Parameters**:
  - `repositoryId` (string, required): ID of the repository.
- **Returns**: `{ status: "synced", filesUpdated: number }`.

### `get_repository_graph_preference` / `set_repository_graph_preference`
- **Scope**: Repository or Account.
- **Parameters**: `repositoryId` and `include` (for set).
- **Returns**: `{ repositoryId, include }`.

---

## 4. Search & Knowledge Graph

### `search`
- **Scope**: Any.
- **Parameters**:
  - `query` (string, required): Search query.
  - `vaultId` (string, optional): Restrict to specific vault.
  - `repositoryId` (string, optional): Restrict to specific repository.
  - `limit` (number, optional): Maximum results (default: 20).
  - `type` (string, optional): `"notes"`, `"repos"`, or `"all"`.
- **Returns**: Ranked list of matches with `title`, `path`, `snippet`, `score`, `sourceType`.

### `graph`
- **Scope**: Any.
- **Parameters**:
  - `vaultId` (string, optional): Restrict to specific vault.
  - `repositoryId` (string, optional): Restrict to specific repo.
  - `types` (array of strings, optional): Filter by note or symbol types.
  - `tags` (array of strings, optional): Filter by tags.
  - `aggregate` (string, optional): Set to `"community"` for Louvain community clustering (collapsing the graph into community super-nodes).
  - `community` (number, optional): Filter to members of a single Louvain community.
  - `limit` (number, optional): Maximum nodes to return.
- **Returns**: `{ nodes: [...], edges: [...], communities: [...] }`.
