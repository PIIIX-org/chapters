# Chapters MCP Tool Reference

This document provides exact parameter details, response structures, and usage examples for all 57 Chapters Model Context Protocol (MCP) tools and 20 first-class MCP Engineering Prompts.

Chapters MCP server exposes stateless, permission-scoped tools (`POST /mcp` via Streamable HTTP transport or stdio).

---

## 1. Vault Management

### `list_vaults`
- **Scope**: Account-level only.
- **Parameters**: None.
- **Returns**: Array of vault objects:
  ```json
  [
    {
      "id": "uuid",
      "name": "Knowledge Base",
      "description": "Team architectural notes",
      "mergeable": true,
      "permission": "owner",
      "createdAt": "2026-09-22T10:00:00Z",
      "updatedAt": "2026-10-01T15:30:00Z"
    }
  ]
  ```

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
  - `vaultId` (string, optional): ID of the vault (required for account-scoped tokens).
  - `path` (string, optional): Directory path within the vault for progressive disclosure (defaults to root `""`).
  - `recursive` (boolean, optional): If `true`, returns all notes recursively across the vault or subdirectory. If `false` (default when `path` is provided), returns progressive disclosure object with `directory`, `subdirectories` (with child counts), direct `notes`, and immediate `indexContent`.
- **Returns**: Array of notes, or when `path` is specified without `recursive: true`:
  ```json
  {
    "directory": "domains/auth",
    "subdirectories": [
      { "name": "tokens", "count": 3 }
    ],
    "notes": [
      {
        "id": "uuid",
        "path": "domains/auth/index.md",
        "title": "Authentication Architecture",
        "type": "concept",
        "status": "stable",
        "updatedAt": "2026-09-22T10:00:00Z"
      }
    ],
    "indexContent": "# Authentication Architecture\n..."
  }
  ```

### `update_vault`
- **Scope**: Vault or Account (owner only).
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
- **Returns**: `{ "vaultId": "uuid", "include": true }`.

### `set_vault_graph_preference`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `include` (boolean, required): Whether to include this vault in your merged graph view.
- **Returns**: `{ "vaultId": "uuid", "include": boolean }`.

### `get_vault_preferences`
- **Scope**: Account-level.
- **Parameters**: None.
- **Returns**: User's vault preferences object including `storageMode` (`"online"` or `"local"`), custom folder mappings (`folders`), `folderColors`, `vaultColors`, and `favorites`.

### `update_vault_preferences`
- **Scope**: Account-level.
- **Parameters**:
  - `storageMode` (enum: `"online"` | `"local"`, optional): Storage mode preference.
  - `folders` (record<string, string>, optional): Folder mapping dictionary.
  - `folderColors` (record<string, string>, optional): Custom hex colors per folder.
  - `vaultColors` (record<string, string>, optional): Custom hex colors per vault.
  - `favorites` (record<string, boolean>, optional): Map of favorite vault IDs.
- **Returns**: Updated user preferences.

### `delete_vault`
- **Scope**: Vault or Account (owner only).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
- **Returns**: `{ "ok": true, "message": "Vault moved to trash" }`.

### `restore_vault`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, required): ID of the trashed vault.
- **Returns**: Restored vault object.

### `purge_vault`
- **Scope**: Vault or Account (owner only, must already be trashed).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault to permanently delete.
- **Returns**: `{ "ok": true, "purged": true }`.

### `list_vault_shares`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
- **Returns**: Array of share records (`id`, `granteeType`: `"user"` | `"team"`, `granteeId`, `permission`: `"read"` | `"edit"`).

### `share_vault`
- **Scope**: Vault or Account (owner only).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `userId` (string, optional): User ID to share with.
  - `teamId` (string, optional): Team ID to share with.
  - `permission` (enum: `"read"` | `"edit"`, required): Access level granted.
- **Returns**: Created share object.

### `revoke_vault_share`
- **Scope**: Vault or Account (owner only).
- **Parameters**:
  - `vaultId` (string, required): ID of the vault.
  - `userId` (string, optional): User ID to revoke from.
  - `teamId` (string, optional): Team ID to revoke from.
- **Returns**: Confirmation message.

---

## 2. Note Operations & OKF Conformance

### `read_note`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault (required for account-scoped tokens).
  - `path` (string, required): Clean note path (e.g. `"domains/auth/tokens.md"`, with or without `.md`).
- **Returns**: Complete note object with `id`, `path`, `title`, `type`, `frontmatter`, `content`, `status`, and `updatedAt`.

### `create_note`
- **Scope**: Vault or Account (edit permission).
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault.
  - `path` (string, optional): Direct note path (e.g. `"domains/storage/postgres.md"`). Supports up to 8 levels of nested slug directories.
  - `type` (enum: `"concept"` | `"spec"` | `"guide"` | `"meeting"` | `"reference"` | `"decision"`, optional): Type folder (used when `path` is omitted).
  - `name` (string, optional): Note filename slug (used when `path` is omitted).
  - `content` (string, required): Full markdown note body with YAML frontmatter.
- **Returns**: Created note object.

### `edit_note`
- **Scope**: Vault or Account (edit permission).
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault.
  - `path` (string, required): Path of the note to update.
  - `content` (string, required): Full replacement markdown content. Edits automatically flow through the collaborative CRDT engine, creating attributed audit revisions.
- **Returns**: Updated note object.

### `rename_note`
- **Scope**: Vault or Account (edit permission).
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault.
  - `oldPath` (string, required): Current note path.
  - `newPath` (string, required): Target destination note path. Automatically refactors incoming wikilinks across other notes to prevent dead graph links.
- **Returns**: Renamed note object.

### `delete_note`
- **Scope**: Vault or Account (edit permission).
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault.
  - `path` (string, required): Path of the note to soft-delete.
- **Returns**: Confirmation message (note moved to vault trash).

### `list_trash`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault.
- **Returns**: Array of trashed note items with deletion timestamps.

### `restore_note`
- **Scope**: Vault or Account (edit permission).
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault.
  - `path` (string, required): Path of the note in trash to restore.
- **Returns**: Restored note object.

### `purge_note`
- **Scope**: Vault or Account (owner only, must be in trash).
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault.
  - `path` (string, required): Path of the note to permanently erase.
- **Returns**: Confirmation message; note and corresponding semantic graph edges are permanently removed.

### `note_history`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault.
  - `path` (string, required): Path of the note.
- **Returns**: Array of revision objects containing revision ID, author attribution (`user` or `ai`), timestamp, summary, and snapshot length.

### `revert_note`
- **Scope**: Vault or Account (edit permission).
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault.
  - `path` (string, required): Note path.
  - `revisionId` (string, required): Specific revision UUID to revert to. Routes through CRDT collaboration engine.
- **Returns**: Reverted note object with new revision recorded.

### `purge_revision`
- **Scope**: Vault or Account (owner only).
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault.
  - `path` (string, required): Note path.
  - `revisionId` (string, required): Revision UUID to permanently scrub from history.
- **Returns**: `{ "ok": true, "purged": true }`.

### `audit_okf_conformance`
- **Scope**: Vault or Account.
- **Parameters**:
  - `vaultId` (string, optional): ID of the vault to audit (required for account-scoped tokens).
- **Returns**: Comprehensive OKF v0.2 conformance audit report:
  ```json
  {
    "vaultId": "uuid",
    "conformanceScore": 98.5,
    "checks": {
      "isoDatetimeOffsets": { "passed": true, "violations": [] },
      "wikilinkIntegrity": { "passed": true, "broken": [] },
      "repoDeepLinks": { "passed": true, "invalidTargets": [] },
      "progressiveDisclosureIndices": { "passed": true, "missingDirectories": [] },
      "orphanNotes": { "passed": true, "orphans": [] }
    }
  }
  ```

---

## 3. Repositories & Codebase Mapping

### `list_repositories`
- **Scope**: Account-level only.
- **Parameters**: None.
- **Returns**: Array of connected repositories (`id`, `name`, `remoteUrl`, `localPath`, `syncStatus`, `lastSyncedAt`, `commitHash`, `defaultBranch`).

### `connect_repository`
- **Scope**: Account-level.
- **Parameters**:
  - `url` (string, optional): Git remote clone URL (e.g. `https://github.com/org/repo.git`).
  - `localPath` (string, optional): Absolute path to repository on local filesystem.
  - `name` (string, optional): Friendly name for the repository.
  - `branch` (string, optional): Default branch to track (defaults to remote default or `"main"`).
- **Returns**: Created repository record with initial indexing triggered.

### `browse_repository`
- **Scope**: Repository or Account.
- **Parameters**:
  - `repositoryId` (string, optional): Target repository ID.
  - `path` (string, optional): Relative directory path within repository (defaults to root `""`).
- **Returns**: Directory listing containing child files and subdirectories with sizes and AST symbol counts.

### `read_file`
- **Scope**: Repository or Account.
- **Parameters**:
  - `repositoryId` (string, optional): Repository ID.
  - `path` (string, required): Relative file path within repository.
- **Returns**: Complete file contents, line count, language identifier, and full Tree-sitter AST symbol outline (functions, classes, interfaces, methods, and line ranges).

### `repository_status`
- **Scope**: Repository or Account.
- **Parameters**:
  - `repositoryId` (string, optional): Repository ID.
- **Returns**: Repository sync health, status (`"idle"`, `"syncing"`, `"error"`), latest indexed commit SHA, symbol count, and last sync timestamp.

### `sync_repository`
- **Scope**: Repository or Account.
- **Parameters**:
  - `repositoryId` (string, optional): Repository ID.
  - `force` (boolean, optional): Force full re-clone / re-indexing even if commit SHA is unchanged.
- **Returns**: Sync task initiation confirmation.

### `update_repository`
- **Scope**: Repository or Account (owner only).
- **Parameters**:
  - `repositoryId` (string, optional): Repository ID.
  - `name` (string, optional): Updated repository name (1-200 characters).
  - `mergeable` (boolean, optional): Whether code nodes participate in merged cross-vault graphs.
- **Returns**: Updated repository record.

### `get_repository_graph_preference`
- **Scope**: Repository or Account.
- **Parameters**:
  - `repositoryId` (string, required): Repository ID.
- **Returns**: `{ "repositoryId": "uuid", "include": boolean }`.

### `set_repository_graph_preference`
- **Scope**: Repository or Account.
- **Parameters**:
  - `repositoryId` (string, required): Repository ID.
  - `include` (boolean, required): Whether repository nodes are visible in merged graph view.
- **Returns**: `{ "repositoryId": "uuid", "include": boolean }`.

### `delete_repository`
- **Scope**: Repository or Account (owner only).
- **Parameters**:
  - `repositoryId` (string, optional): Repository ID to disconnect and delete.
- **Returns**: Confirmation message; indexes and graph nodes are unlinked.

### `list_repository_shares`
- **Scope**: Repository or Account.
- **Parameters**:
  - `repositoryId` (string, optional): Repository ID.
- **Returns**: Array of read shares (`id`, `granteeType`: `"user"` | `"team"`, `granteeId`).

### `share_repository`
- **Scope**: Repository or Account (owner only).
- **Parameters**:
  - `repositoryId` (string, optional): Repository ID.
  - `granteeType` (enum: `"user"` | `"team"`, required): Type of recipient.
  - `granteeId` (string, required): UUID of target user or team.
- **Returns**: Created repository share record.

### `revoke_repository_share`
- **Scope**: Repository or Account (owner only).
- **Parameters**:
  - `repositoryId` (string, optional): Repository ID.
  - `shareId` (string, required): UUID of the share record to revoke.
- **Returns**: `{ "ok": true }`.

---

## 4. Search & AST Code Symbols

### `search`
- **Scope**: Any scope.
- **Parameters**:
  - `query` (string, required): Search query string.
  - `vaultId` (string, optional): Restrict search to specific vault.
  - `repositoryId` (string, optional): Restrict search to specific repository.
  - `everywhere` (boolean, optional): Search across all accessible vaults and repositories (account scope only).
  - `symbols` (boolean, optional): Include individual AST code symbols (functions, classes, interfaces, types) in results (defaults to `true`).
  - `limit` (integer, optional): Maximum results to return (1-100, default: 20).
- **Returns**: Ranked array of search results with snippet previews, highlights, score, and source breadcrumbs.

### `find_symbols`
- **Scope**: Any scope (Repository or Account).
- **Parameters**:
  - `query` (string, required): Search query targeting symbol semantics, signature, or name.
  - `kind` (enum: `"function"` | `"class"` | `"interface"` | `"type"`, optional): Filter by symbol kind.
  - `repositoryId` (string, optional): Constrain search to a specific repository.
  - `everywhere` (boolean, optional): Search across all accessible repositories.
  - `limit` (integer, optional): Maximum symbols to return (1-50, default: 20).
- **Returns**: Precise symbol declarations with line numbers, container file paths, and exact signatures without burning context reading whole files:
  ```json
  [
    {
      "name": "buildGraph",
      "kind": "function",
      "file": "server/src/graph/assemble.ts",
      "lineStart": 145,
      "lineEnd": 210,
      "signature": "export async function buildGraph(resources: ResourceSet): Promise<Graph>",
      "repositoryId": "uuid"
    }
  ]
  ```

---

## 5. Knowledge Graph & Perspectives

### `graph`
- **Scope**: Any scope.
- **Parameters**:
  - `vaultId` (string, optional): Scoped vault ID.
  - `repositoryId` (string, optional): Scoped repository ID.
  - `aggregate` (enum: `"community"`, optional): Aggregate nodes into high-level Louvain communities.
  - `community` (integer, optional): Drill down into a specific Louvain community ID.
  - `neighborsOf` (string, optional): Note ID, path, or code file path to return immediate 1-hop subgraph.
  - `edgeTypes` (array<string>, optional): Filter edges: `["EXTRACTED", "STRUCTURAL", "SEMANTIC"]`.
  - `limit` (integer, optional): Maximum nodes (default: 500).
- **Returns**: Topological graph object with `nodes` (id, label, type, community, pagerank), `edges` (source, target, type, weight), and `communities`.

### `find_graph_path`
- **Scope**: Any scope.
- **Parameters**:
  - `source` (string, required): Source note path, note ID, or code file path.
  - `target` (string, required): Target note path, note ID, or code file path.
  - `vaultId` (string, optional): Optional vault ID constraint.
  - `repositoryId` (string, optional): Optional repository ID constraint.
- **Returns**: Shortest path connecting the two entities: ordered list of node steps and connecting edges with relationship types (`EXTRACTED`, `STRUCTURAL`, `SEMANTIC`).

### `list_graph_perspectives`
- **Scope**: Any scope.
- **Parameters**:
  - `vaultId` (string, optional): Filter to perspectives for a specific vault. Omit to list global/merged graph perspectives.
- **Returns**: Array of saved perspective presets (`id`, `name`, `vaultId`, `filters`: types, tags, since, until, colorMode, `isShared`, `createdAt`).

### `save_graph_perspective`
- **Scope**: Vault or Account (Account requires admin role for global perspectives).
- **Parameters**:
  - `name` (string, required): Perspective display name.
  - `vaultId` (string, optional): Vault ID constraint (omit for global perspective).
  - `filters` (object, optional):
    - `types` (array<string>, optional): Filter by note types (`["concept", "spec", "decision"]`).
    - `tags` (array<string>, optional): Filter by tag list.
    - `since` (string, optional): ISO datetime start bound.
    - `until` (string, optional): ISO datetime end bound.
    - `colorMode` (string, optional): Graph coloring scheme (`"community"`, `"type"`, `"staleness"`).
  - `isShared` (boolean, optional): Whether visible to other vault/team members (default: `true`).
- **Returns**: Created perspective record.

### `delete_graph_perspective`
- **Scope**: Any scope (creator, vault owner, or system admin).
- **Parameters**:
  - `id` (string, required): Perspective UUID to delete.
- **Returns**: `{ "ok": true }`.

---

## 6. Teams & Users

### `list_teams`
- **Scope**: Account-level.
- **Parameters**: None.
- **Returns**: Array of teams the user belongs to or manages (`id`, `name`, `role`, `memberCount`, `createdAt`).

### `create_team`
- **Scope**: Account-level.
- **Parameters**:
  - `name` (string, required): Team name (1-100 characters).
- **Returns**: Created team record.

### `list_team_members`
- **Scope**: Account-level.
- **Parameters**:
  - `teamId` (string, required): Team UUID.
- **Returns**: Array of team member records (`userId`, `email`, `name`, `role`, `joinedAt`).

### `add_team_member`
- **Scope**: Account-level (team owner role).
- **Parameters**:
  - `teamId` (string, required): Team UUID.
  - `userId` (string, required): User UUID to add.
- **Returns**: Confirmation record.

### `remove_team_member`
- **Scope**: Account-level (team owner role).
- **Parameters**:
  - `teamId` (string, required): Team UUID.
  - `userId` (string, required): User UUID to remove.
- **Returns**: Confirmation record.

### `delete_team`
- **Scope**: Account-level (team owner role).
- **Parameters**:
  - `teamId` (string, required): Team UUID to delete.
- **Returns**: Confirmation message.

### `lookup_user`
- **Scope**: Account-level.
- **Parameters**:
  - `email` (string, required): Exact email address of the user to look up.
- **Returns**: User summary (`id`, `email`, `name`) for sharing or team assignment.

---

## 7. Export & Notifications

### `export_vault`
- **Scope**: Vault or Account (requires edit access).
- **Parameters**:
  - `vaultId` (string, optional): Vault UUID to export.
- **Returns**: Base64-encoded zip archive payload and uncompressed byte size.

### `export_note`
- **Scope**: Vault or Account (requires read access).
- **Parameters**:
  - `vaultId` (string, optional): Vault UUID.
  - `path` (string, required): Note path.
- **Returns**: Raw serialized markdown string with complete OKF frontmatter.

### `list_notifications`
- **Scope**: Account-level.
- **Parameters**:
  - `unreadOnly` (boolean, optional): If `true`, returns only unread notifications.
  - `limit` (integer, optional): Maximum notifications to return (1-100, default: 20).
- **Returns**: Array of notification events (`id`, `type`, `title`, `message`, `read`, `createdAt`).

### `mark_notification_read`
- **Scope**: Account-level.
- **Parameters**:
  - `notificationId` (string, required): Notification UUID to mark as read.
- **Returns**: `{ "ok": true }`.

---

## 8. Chapters MCP Prompts Suite (20 First-Class Engineering Prompts)

Chapters implements the Model Context Protocol Prompts specification (`prompts/list` and `prompts/get`), providing 20 context-hydrating prompts designed for deep engineering workflows:

| # | Prompt Name | Category | Description | Primary Inputs |
| :- | :--- | :--- | :--- | :--- |
| 1 | `active_project_companion` | Flagship Session | Anchors agent to a project vault for continuous real-time capture of decisions and notes as code is written. | `projectName`, `taskDescription`, `vaultId?` |
| 2 | `sync_local_docs_to_vault` | Ingestion | Scans local markdown notes in project directories (`docs/`, `specs/`) and syncs them to the Chapters vault. | `vaultId?`, `localFolder?` |
| 3 | `plan_feature_implementation` | Architecture | Inspects existing specs and codebase patterns to formulate a step-by-step, zero-hallucination implementation plan. | `featureName`, `description`, `vaultId?`, `repositoryId?` |
| 4 | `prepare_task_context` | Context Assembly | Bundles relevant notes, AST symbols, and graph connections for an upcoming coding task. | `task`, `vaultId?`, `repositoryId?` |
| 5 | `draft_adr` | Governance | Synthesizes an Architecture Decision Record (ADR) in strict OKF format with alternatives and trade-offs. | `title`, `context`, `decision`, `vaultId?` |
| 6 | `draft_rfc` | Governance | Generates a comprehensive Request for Comments (RFC) covering motivation, architecture, rollout, and risks. | `title`, `summary`, `vaultId?` |
| 7 | `generate_api_spec` | API Design | Inspects code entrypoints and schemas to generate an OpenAPI/REST or MCP protocol specification note. | `subsystem`, `format?`, `vaultId?`, `repositoryId?` |
| 8 | `explain_code_architecture` | Exploration | Summarizes a subsystem's design, entrypoints, and invariants using the knowledge graph and AST symbols. | `target`, `vaultId?`, `repositoryId?` |
| 9 | `onboard_subsystem` | Onboarding | Generates an accelerated developer onboarding brief for a specific codebase subsystem or domain. | `domain`, `vaultId?`, `repositoryId?` |
| 10 | `summarize_concept_chain` | Pathfinding | Leverages `find_graph_path` to explain how two distinct concepts or code components connect across the graph. | `source`, `target`, `vaultId?` |
| 11 | `audit_architecture_drift` | Integrity | Compares documented OKF specifications against actual code AST symbols and flags divergence. | `domain`, `vaultId?`, `repositoryId?` |
| 12 | `refactor_impact_analysis` | Safety | Traces backlinks, call sites, and graph dependencies to calculate the blast radius of a planned refactor. | `symbolOrFile`, `vaultId?`, `repositoryId?` |
| 13 | `audit_orphaned_code` | Hygiene | Discovers unlinked notes, unused AST symbols, and dark matter code lacking documentation. | `vaultId?`, `repositoryId?` |
| 14 | `test_gap_analysis` | Quality | Audits core domain notes and specs against existing test suites to surface uncovered invariants. | `subsystem`, `vaultId?`, `repositoryId?` |
| 15 | `pr_review_against_specs` | Verification | Evaluates a PR or code change against established OKF architecture specifications and invariants. | `diffOrSummary`, `vaultId?`, `repositoryId?` |
| 16 | `generate_release_notes` | Delivery | Compiles user-facing and technical release notes from recent notes, ADRs, and commit history. | `version`, `sinceDate?`, `vaultId?` |
| 17 | `audit_security_surface` | Security | Analyzes ingress points, auth routes, and trust boundaries documented in the knowledge graph. | `vaultId?`, `repositoryId?` |
| 18 | `database_schema_evolution` | Data Modeling | Reviews data model notes and migration files for backward compatibility, index hygiene, and invariants. | `tableName`, `vaultId?`, `repositoryId?` |
| 19 | `supernode_bottleneck_audit` | Topology | Identifies graph supernodes (PageRank hotspots) indicating architectural tight coupling or monolith risk. | `vaultId?` |
| 20 | `incident_postmortem` | Reliability | Structures a blameless post-mortem note referencing affected components, timeline, and remediation tasks. | `incidentName`, `summary`, `vaultId?` |
