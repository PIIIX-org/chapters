---
name: chapters
description: Connects AI agents to Chapters — an open-source, self-hostable second brain and AI-navigable knowledge graph platform with synced code repositories. Use whenever interacting with Chapters vaults, notes, knowledge graphs, codebase mappings, or when navigating projects via Chapters MCP tools.
---

# Chapters Agent Skill

This skill enables AI agents to natively understand, navigate, and operate **Chapters** — an open-source, self-hostable "second brain" web platform with plain markdown/YAML notes (Open Knowledge Format), synced code repositories, and an AI-navigable knowledge graph accessible via Model Context Protocol (MCP).

When this skill is active, **you do not need to ask the user what Chapters is or whether the MCP server is available.** You already know Chapters is active, understand its architecture, and proactively use the Chapters MCP tools for project navigation, retrieval, note management, and code exploration.

---

## What is Chapters?

Chapters is a team knowledge base and codebase mapping platform built on four foundational pillars:

1. **Notes as Plain Files (OKF)**: Every note is a markdown file with YAML frontmatter following Google's Open Knowledge Format (OKF). Notes support typed relationships and bidirectional wikilinks (`[[note-name]]`, `[[note-name|display text]]`, and `[[repo:repo-id/path/to/file]]`).
2. **AI-Navigable Knowledge Graph**: The graph links notes and code via three edge types:
   - `EXTRACTED`: Explicit wikilinks and code imports/calls derived via Tree-sitter.
   - `STRUCTURAL`: Notes sharing metadata properties, tags, or hierarchies.
   - `INFERRED` / `SEMANTIC`: Top-k nearest neighbors computed from local ONNX embeddings in a shared vector space.
   - Nodes are clustered using Louvain community detection and ranked via PageRank.
3. **Synced Code Repositories**: Read-only ingestion of git repositories (via git clone/poll/webhook, local filesystem watch, or CLI push) indexed with Tree-sitter AST symbol extraction and semantic embeddings.
4. **First-Class MCP Server**: A stateless, permission-scoped MCP server (`POST /mcp` via Streamable HTTP transport or stdio) providing 49 tools with full system parity.

---

## Agent Operating Guidelines

### 1. Graph-First Navigation Protocol
When exploring a project or answering questions about architecture, concepts, or code:
- **Do not scan all files blindly.**
- **Step 1 — Search**: Run `search` (or `/chapters-search`) with a query to find relevant notes and code symbols using hybrid (lexical + vector) retrieval.
- **Step 2 — Graph Topology**: Use `graph` (or `/chapters-graph`) with `aggregate: "community"` to view high-level community clusters, or inspect immediate neighbors (`neighbors_of`) and backlinks.
- **Step 3 — Read Context**: Use `read_note` or `read_file` only for the specific notes and code files identified by the search/graph.

### 2. Note Creation & Editing (OKF Standard)
When creating or editing notes via `create_note` or `edit_note`:
- Always include valid YAML frontmatter at the top:
  ```markdown
  ---
  title: "Descriptive Title"
  type: concept # or spec, guide, meeting, reference, decision
  tags: [tag1, tag2]
  created: YYYY-MM-DD
  ---

  # Descriptive Title

  Body content with [[wikilinks]] connecting related concepts.
  Link to code files using [[repo:repo-id/path/to/file]].
  ```
- Edits flow through the collaborative CRDT engine, creating attributed audit revisions.

---

## Slash Commands

This skill equips agents and users with standard slash commands:

### `/chapters-status`
Checks Chapters MCP connection, lists active vaults, connected repositories, and unread notifications.
- **Tools called**: `list_vaults`, `list_repositories`, `list_notifications`
- **Output**: Connection health, token scope (`account`, `vault`, or `repository`), vault count, repo count, and pending notifications.

### `/chapters-search <query> [--type notes|repos|all] [--vault <id>] [--repo <id>]`
Executes hybrid lexical + semantic search across notes and codebases.
- **Tool called**: `search`
- **Options**:
  - `--type`: Filter by `notes`, `repos`, or `all` (default: `all`).
  - `--vault`: Restrict search to a specific vault ID.
  - `--repo`: Restrict search to a specific repository ID.
- **Example**: `/chapters-search "authentication session validation" --type all`

### `/chapters-graph [query] [--vault <id>] [--repo <id>] [--aggregate] [--community <id>]`
Queries and traverses the knowledge graph.
- **Tool called**: `graph`
- **Options**:
  - `--aggregate`: Aggregate nodes into Louvain communities (high-level view).
  - `--community <id>`: Drill down into a specific Louvain community cluster.
  - `--vault <id>`: Filter to a specific vault.
  - `--repo <id>`: Filter to a specific repository.
- **Example**: `/chapters-graph --aggregate`

### `/chapters-note <action> [arguments...]`
Performs operations on notes:
- `/chapters-note read <vault-id> <path>`: Read note content and frontmatter.
- `/chapters-note create <vault-id> <path> [content]`: Create a new OKF note.
- `/chapters-note edit <vault-id> <path> <content>`: Update existing note content.
- `/chapters-note rename <vault-id> <old-path> <new-path>`: Rename a note.
- `/chapters-note delete <vault-id> <path>`: Move note to trash.
- `/chapters-note history <vault-id> <path>`: View revision history and attribution.
- `/chapters-note revert <vault-id> <path> <revision-id>`: Revert to a previous revision.

### `/chapters-repo <action> [arguments...]`
Performs operations on connected codebase repositories:
- `/chapters-repo list`: List all connected repositories.
- `/chapters-repo browse <repo-id> [path]`: Browse file and folder hierarchy.
- `/chapters-repo read <repo-id> <file-path>`: Read file content and AST symbol outline.
- `/chapters-repo status <repo-id>`: View sync freshness, commit hash, and indexing status.
- `/chapters-repo sync <repo-id>`: Trigger an immediate repository sync.

### `/chapters-vault <action> [arguments...]`
Manages vaults and sharing:
- `/chapters-vault list`: List accessible vaults and permissions.
- `/chapters-vault browse <vault-id> [path]`: Browse notes hierarchy in a vault.
- `/chapters-vault create <name> [description]`: Create a new vault.
- `/chapters-vault preference <vault-id> [include true|false]`: View or set merged-graph preference.

### `/chapters-map <repo-id-or-path> [--vault <vault-id>] [--name <vault-name>]`
Maps an entire project or codebase repository into an interconnected, Open Knowledge Format (OKF v0.2) Knowledge Bundle within Chapters following the **5-Phase Flawless OKF Mapping Protocol** ([`references/codebase-mapping-protocol.md`](references/codebase-mapping-protocol.md)), engineered from Google's Open Knowledge Format standards ([`references/okf-format.md`](references/okf-format.md)).

- **Workflow for Agents (The 5-Phase OKF Protocol)**:
  1. **Phase 0 — Target Binding**: Check repository connection (`list_repositories` / `connect_repository`) and locate or initialize the target vault (`list_vaults` / `create_vault`).
  2. **Phase 1 — Discovery & Manifest Analysis**:
     - Parse build manifests (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Dockerfile`).
     - Detect runtime engines, primary web/API frameworks, database/ORM layers, and all ingress boundaries (HTTP, WebSockets, CLI binaries, MCP servers, background worker queues).
  3. **Phase 2 — Architectural Domain Partitioning**:
     - Decompose the codebase into 4 to 8 cohesive bounded domains (e.g. Auth/Security, Data/Storage, API/Ingress, Core Domain Engine, Client/UI).
     - Identify lead implementation files, exported symbol interfaces, and hard architectural invariants.
  4. **Phase 3 — Structured OKF Note Synthesis**:
     - Create notes via Chapters MCP `create_note` conforming to OKF v0.2 schemas:
       - **Root System Index (`index.md`)**: High-level overview, architecture blueprint, domain roster, entrypoints, and technology stack table with `[[repo:...]]` links.
       - **Domain Concept Notes (`domains/<domain>/index.md`)**: Architectural responsibilities, invariants, and implementation files.
       - **End-to-End Workflow Specs (`specs/<flow>.md`)**: Sequence steps, trust boundaries, and error recovery contracts.
       - **Data Model Notes (`models/<entity>.md`)**: Entity schemas, relationships, and code definitions.
       - **Architecture Decisions (`decisions/ADR-<nnn>-<title>.md`)**: Context, decisions, trade-offs, and alternatives considered.
  5. **Phase 4 — Progressive Disclosure Synthesis**:
     - Ensure every directory level contains an `index.md` summarizing child concepts, allowing AI agents to navigate progressively without overflowing context windows.
  6. **Phase 5 — Knowledge Graph Audit & Validation**:
     - Audit link integrity: zero broken `[[wikilinks]]` and valid `[[repo:...]]` code targets.
     - Call Chapters MCP `graph` with `aggregate: "community"` to verify cohesive Louvain community clusters and confirm zero orphan notes.
     - Call Chapters MCP `search` to verify top-k hybrid search retrieval across all mapped domains.

### `/chapters-export <vault-id|note-path>`
Exports a vault or note archive.
- **Tools called**: `export_vault`, `export_note`

---

## Chapters MCP Tool Reference

Chapters exposes 49 tools across 6 functional domains:

### 1. Vault Management
| Tool | Scope | Description |
| :--- | :--- | :--- |
| `list_vaults` | Account | List all vaults accessible to the current user. |
| `create_vault` | Account | Create a new vault with name, description, and settings. |
| `browse_vault` | Vault/Account | Browse directory and note structure within a vault. |
| `update_vault` | Vault/Account | Update vault name, description, or mergeable settings. |
| `get_vault_graph_preference` | Vault/Account | Get user's personal merged-graph inclusion preference. |
| `set_vault_graph_preference` | Vault/Account | Set user's personal merged-graph inclusion preference. |
| `delete_vault` | Vault/Account | Soft-delete a vault into trash (owner only). |
| `restore_vault` | Vault/Account | Restore a soft-deleted vault from trash. |
| `purge_vault` | Vault/Account | Permanently purge a trashed vault from disk and DB. |
| `list_vault_shares` | Vault/Account | List user and team shares for a vault. |
| `share_vault` | Vault/Account | Grant read or edit access to a user or team. |
| `revoke_vault_share` | Vault/Account | Revoke a user or team share from a vault. |

### 2. Note Operations
| Tool | Scope | Description |
| :--- | :--- | :--- |
| `read_note` | Vault/Account | Read note markdown content, frontmatter, and metadata. |
| `create_note` | Vault/Account | Create a new OKF note at path with frontmatter. |
| `edit_note` | Vault/Account | Update note content through CRDT live collaboration. |
| `rename_note` | Vault/Account | Rename or move a note within the vault. |
| `delete_note` | Vault/Account | Soft-delete a note to the vault trash. |
| `list_trash` | Vault/Account | List soft-deleted notes in the vault trash. |
| `restore_note` | Vault/Account | Restore a trashed note back to the vault. |
| `purge_note` | Vault/Account | Permanently delete a note and clean semantic edges. |
| `note_history` | Vault/Account | View revision history with user/AI attribution. |
| `revert_note` | Vault/Account | Revert a note to a prior revision without losing history. |
| `purge_revision` | Vault/Account | Permanently erase a recorded revision (owner only). |

### 3. Repository & Codebase Mapping
| Tool | Scope | Description |
| :--- | :--- | :--- |
| `list_repositories` | Account | List all connected codebase repositories. |
| `connect_repository` | Account | Connect a repo (git URL or local filesystem path). |
| `browse_repository` | Repo/Account | Browse directory structure of a repository. |
| `read_file` | Repo/Account | Read code file content with AST symbol outline. |
| `repository_status` | Repo/Account | Check sync freshness, commit SHA, and indexing status. |
| `sync_repository` | Repo/Account | Trigger immediate synchronization of a repository. |
| `update_repository` | Repo/Account | Update repository settings or default branch. |
| `get_repository_graph_preference` | Repo/Account | Get user's merged-graph inclusion preference. |
| `set_repository_graph_preference` | Repo/Account | Set user's merged-graph inclusion preference. |
| `delete_repository` | Repo/Account | Disconnect and remove a repository. |
| `list_repository_shares` | Repo/Account | List user and team read shares for a repository. |
| `share_repository` | Repo/Account | Share read access with a user or team. |
| `revoke_repository_share` | Repo/Account | Revoke repository read access. |

### 4. Search & Knowledge Graph
| Tool | Scope | Description |
| :--- | :--- | :--- |
| `search` | Any | Hybrid search (lexical + semantic) across notes and code. |
| `graph` | Any | Query graph nodes, edges (extracted/structural/semantic), Louvain communities. |

### 5. Teams & Users
| Tool | Scope | Description |
| :--- | :--- | :--- |
| `list_teams` | Account | List teams the user belongs to or manages. |
| `create_team` | Account | Create a new team. |
| `list_team_members` | Account | List members in a team. |
| `add_team_member` | Account | Add a user to a team. |
| `remove_team_member` | Account | Remove a user from a team. |
| `delete_team` | Account | Delete a team. |
| `lookup_user` | Account | Lookup a user by exact email address. |

### 6. Export & Notifications
| Tool | Scope | Description |
| :--- | :--- | :--- |
| `export_vault` | Vault/Account | Export an entire vault as a zip archive. |
| `export_note` | Vault/Account | Export a single note as markdown. |
| `list_notifications` | Account | List in-app notifications and activity feed. |
| `mark_notification_read` | Account | Mark notifications as read. |

---

## Platform Installation & Configuration Guides

### 1. Anthropic Claude (Claude Desktop & Claude Code)
- **Claude Desktop**:
  Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):
  ```json
  {
    "mcpServers": {
      "chapters": {
        "url": "http://localhost:3000/mcp",
        "headers": {
          "Authorization": "Bearer YOUR_CHAPTERS_MCP_TOKEN"
        }
      }
    }
  }
  ```
- **Claude Code**:
  Add MCP server via CLI:
  ```bash
  claude mcp add chapters http://localhost:3000/mcp --header "Authorization: Bearer YOUR_CHAPTERS_MCP_TOKEN"
  ```
  Install skill:
  ```bash
  mkdir -p ~/.claude/skills/chapters && cp -r skills/chapters/* ~/.claude/skills/chapters/
  ```

### 2. Cursor & Windsurf
- **Cursor**:
  1. Open **Cursor Settings** > **Features** > **MCP**.
  2. Click **+ Add New MCP Server**.
  3. Set Name: `chapters`, Type: `sse` or `http`, URL: `http://localhost:3000/mcp`.
  4. Add Header: `Authorization: Bearer YOUR_CHAPTERS_MCP_TOKEN`.
  5. Install skill for Cursor rules:
     ```bash
     mkdir -p .cursor/rules && cp skills/chapters/SKILL.md .cursor/rules/chapters.mdc
     ```
- **Windsurf (Codeium)**:
  Configure `~/.codeium/windsurf/mcp_config.json`:
  ```json
  {
    "mcpServers": {
      "chapters": {
        "url": "http://localhost:3000/mcp",
        "headers": {
          "Authorization": "Bearer YOUR_CHAPTERS_MCP_TOKEN"
        }
      }
    }
  }
  ```

### 3. Google Gemini & Antigravity
- **Antigravity CLI**:
  Add to `~/.gemini/antigravity-cli/mcp/chapters.json` or through MCP configuration:
  ```json
  {
    "url": "http://localhost:3000/mcp",
    "headers": {
      "Authorization": "Bearer YOUR_CHAPTERS_MCP_TOKEN"
    }
  }
  ```
  Install the agent skill:
  ```bash
  mkdir -p ~/.agents/skills/chapters && cp -r skills/chapters/* ~/.agents/skills/chapters/
  ```
- **Gemini CLI / Extensions**:
  Set environment variables:
  ```bash
  export CHAPTERS_URL="http://localhost:3000/mcp"
  export CHAPTERS_TOKEN="YOUR_CHAPTERS_MCP_TOKEN"
  ```

### 4. OpenAI Codex & Open Agent Frameworks
- **Skills CLI (`npx skills`)**:
  ```bash
  npx skills add PIIIX-org/chapters@skills/chapters
  ```
- **Workspace-level installation**:
  ```bash
  mkdir -p .agents/skills/chapters && cp -r skills/chapters/* .agents/skills/chapters/
  ```

---

## Keeping the Skill Always Active (Always-On Mode)

If you want your AI agent to keep Chapters **permanently active** across every session without needing keyword triggers or manual reminders:

### One-Command Setup
Run the included installer script from the repository root:
```bash
# Install for all agents:
./skills/chapters/scripts/install-always-on.sh all

# Or for a specific tool:
./skills/chapters/scripts/install-always-on.sh antigravity  # Gemini / Antigravity
./skills/chapters/scripts/install-always-on.sh claude       # Anthropic Claude
./skills/chapters/scripts/install-always-on.sh cursor       # Cursor
./skills/chapters/scripts/install-always-on.sh windsurf     # Windsurf
```

### Manual Setup
- **Google Gemini / Antigravity**:
  Copy [`skills/chapters/rules/chapters.md`](rules/chapters.md) to `~/.gemini/config/rules/chapters.md`. It will be automatically injected into every conversation.
- **Anthropic Claude (Claude Code / Desktop)**:
  Append the contents of [`skills/chapters/rules/chapters.md`](rules/chapters.md) to `~/.claude/CLAUDE.md` or your project's `CLAUDE.md`.
- **Cursor**:
  Create `.cursor/rules/chapters.mdc` with `alwaysApply: true` and the contents of `rules/chapters.md`.
- **Windsurf**:
  Append the contents of `rules/chapters.md` to `.windsurfrules`.

*Note: Generate an MCP bearer token in the Chapters UI at `/settings` (Settings > MCP Connections) or through the Admin panel.*
