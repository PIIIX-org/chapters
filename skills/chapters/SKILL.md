---
name: chapters
description: Connects AI agents to Chapters (now Elara) — an open-source, self-hostable second brain and AI-navigable knowledge graph platform with synced code repositories. Backward-compatibility proxy for the Elara skill.
---

# Chapters Agent Skill (Legacy Compatibility Proxy)

> [!NOTE]
> **Chapters is now Elara.** This skill is maintained as a permanent backward-compatibility proxy. The canonical, actively maintained agent skill is [`skills/elara/SKILL.md`](../elara/SKILL.md). All `/chapters-*` slash commands transparently forward to their canonical `/elara-*` counterparts.

This skill enables AI agents to natively understand, navigate, and operate **Chapters** (now Elara) — an open-source, self-hostable "second brain" web platform with plain markdown/YAML notes (Open Knowledge Format v0.2), synced code repositories, and an AI-navigable knowledge graph accessible via Model Context Protocol (MCP).

When this skill is active, **you do not need to ask the user what Chapters is or whether the MCP server is available.** You already know Chapters is active, understand its architecture, and proactively use the Chapters MCP tools for project navigation, AST code symbol retrieval, concept pathfinding, note management, and code exploration.

---

## What is Chapters?

Chapters is a team knowledge base and codebase mapping platform built on four foundational pillars:

1. **Notes as Plain Files (OKF v0.2)**: Every note is a markdown file with YAML frontmatter following Google's [Open Knowledge Format (OKF v0.2)](https://github.com/GoogleCloudPlatform/open-knowledge-format). Notes support typed relationships, strict ISO 8601 UTC offsets, 8-level nested slug paths, progressive disclosure indices, and bidirectional wikilinks:
   - Note-to-note: `[[note-name]]` or `[[path/to/note|display text]]`
   - Note-to-code: `[[repo:repo-id/path/to/file]]`
   - Symbol-anchored: `[[repo:repo-id/path/to/file#symbol:FunctionName]]`
   - Line-anchored: `[[repo:repo-id/path/to/file#L12-L34]]`
2. **AI-Navigable Knowledge Graph**: The graph links notes and code via three edge types:
   - `EXTRACTED`: Explicit wikilinks and code imports/calls derived via Tree-sitter AST analysis.
   - `STRUCTURAL`: Notes sharing metadata properties, tags, or directory hierarchies.
   - `INFERRED` / `SEMANTIC`: Top-k nearest neighbors computed from local ONNX embeddings in a shared vector space.
   - Topological features include Louvain community detection, PageRank centrality ranking, shortest path finding (`find_graph_path`), and saved graph perspectives with filter presets.
3. **Synced Code Repositories**: Read-only ingestion of git repositories (via git clone/poll/webhook, local filesystem watch, or CLI push) indexed with Tree-sitter AST symbol extraction (functions, classes, interfaces, types) and fine-grained semantic vector embeddings (`find_symbols`).
4. **First-Class MCP Server & Prompts**: A stateless, permission-scoped MCP server (`POST /mcp` via Streamable HTTP transport or stdio) providing **57 tools** with full system parity and **20 first-class engineering prompts** with live context hydration.

---

## Agent Operating Guidelines

### 1. Graph-First Navigation Protocol
When exploring a project or answering questions about architecture, concepts, or code:
- **Do not scan all files blindly.**
- **Step 1 — Search & Symbols**:
  - Run `search` (or `/chapters-search`) with a query to find relevant notes and code files using hybrid (lexical + vector) retrieval.
  - Run `find_symbols` (or `/chapters-symbols`) to pinpoint specific functions, classes, interfaces, or types with exact declaration line numbers without reading whole files.
- **Step 2 — Graph Topology & Pathfinding**:
  - Use `graph` (or `/chapters-graph`) with `aggregate: "community"` to view high-level community clusters, or inspect immediate neighbors (`neighbors_of`) and backlinks.
  - Use `find_graph_path` (or `/chapters-path`) to trace the shortest conceptual path between two components, notes, or code files.
  - Use `list_graph_perspectives` to see curated domain or subsystem perspectives.
- **Step 3 — Read Context**:
  - Use `read_note` or `read_file` only for the specific notes and code files identified by the search/graph.

### 2. Note Creation & Editing (OKF Standard)
When creating or editing notes via `create_note` or `edit_note`:
- Always include valid YAML frontmatter conforming to OKF v0.2:
  ```markdown
  ---
  title: "Descriptive Title"
  type: concept # concept, spec, guide, meeting, reference, decision
  status: stable # draft, active, stable, deprecated, superseded, archived
  tags: [subsystem, architecture]
  created: 2026-10-02T22:00:00Z
  sources:
    - id: "src-1"
      resource: "repo:chapters/server/src/graph/assemble.ts"
      title: "Graph Assembly Engine"
  ---

  # Descriptive Title

  Body content with [[wikilinks]] connecting related concepts.
  Link to code files using [[repo:repo-id/path/to/file]].
  Anchor to symbols using [[repo:repo-id/path/to/file#symbol:FunctionName]].
  ```
- Edits flow through the collaborative CRDT engine, creating attributed audit revisions.
- Validate vaults periodically using `audit_okf_conformance`.

### 3. Post-Task Note Evaluation Protocol
At the conclusion of any task that inspects, refactors, or extends the codebase or notes:
- **Evaluate Existing Notes**: Check if any concept, spec, domain, or data model notes were impacted. Update them via `edit_note`.
- **Evaluate New Notes**: If a new capability, bounded domain, or architectural decision was made, create a new note via `create_note` (e.g. `spec/...` or `decisions/ADR-...`).
- **Confirm to User**: Report note updates and additions as part of the task completion summary.

### 4. Pre-Task Codebase Drift & Note Freshness Protocol
When beginning or resuming work on a project after an interval or when new commits have landed:
- **Step 1 — Codebase Drift Audit**: Compare recent git commits, pull requests, and modified files against existing notes in the project vault (specifically architecture specs, codebase notes, component inventories, and PR resolution records).
- **Step 2 — Identify Stale / Outdated Notes**: Check if schema migrations, new endpoints, refactored components, or modified dependencies have caused notes or specs to diverge from repository reality.
- **Step 3 — Inform the User Explicitly**: Before implementing new features or bug fixes, alert the user with a transparent drift report:
  - Name the specific notes that are outdated (e.g. `[[codebase/chapters]]`, `[[spec/...]]`).
  - Explain exactly why they are stale (e.g. "PR #334 added the universal new button and modified `TopBar.tsx`, but `codebase/chapters` still references the older header layout").
  - Explain why updating the notes first protects the knowledge graph and prevents hallucinated assumptions.
- **Step 4 — Update Notes First**: Update the outdated notes via `edit_note` (and add missing notes via `create_note`) to synchronize the second brain with the actual repository state.
- **Step 5 — Proceed with the Task**: Once the knowledge graph and documentation are verified fresh, continue with the user's primary request.

---

## Slash Commands

This skill equips agents and users with standard slash commands:

### `/chapters-status`
Checks Chapters MCP connection, lists active vaults, connected repositories, and unread notifications.
- **Tools called**: `list_vaults`, `list_repositories`, `list_notifications`

### `/chapters-search <query> [--type notes|repos|all] [--vault <id>] [--repo <id>] [--no-symbols]`
Executes hybrid lexical + semantic search across notes and codebases.
- **Tool called**: `search`
- **Example**: `/chapters-search "authentication session validation"`

### `/chapters-symbols <query> [--kind function|class|interface|type] [--repo <id>] [--everywhere]`
Fine-grained search for code declarations, AST symbols, signatures, and line spans across repositories.
- **Tool called**: `find_symbols`
- **Example**: `/chapters-symbols "buildGraph" --kind function`

### `/chapters-graph [query] [--vault <id>] [--repo <id>] [--aggregate] [--community <id>]`
Queries and traverses the knowledge graph.
- **Tool called**: `graph`
- **Example**: `/chapters-graph --aggregate`

### `/chapters-path <source> <target> [--vault <id>] [--repo <id>]`
Finds the shortest conceptual path connecting two notes, concepts, or code files.
- **Tool called**: `find_graph_path`
- **Example**: `/chapters-path "domains/auth" "server/src/auth/session.ts"`

### `/chapters-perspective [list|save|delete] [...]`
Manages saved graph perspectives and filter presets.
- **Tools called**: `list_graph_perspectives`, `save_graph_perspective`, `delete_graph_perspective`

### `/chapters-prompt <name> [args...]`
Invokes one of the 20 first-class Chapters MCP engineering prompts (e.g. `active_project_companion`, `plan_feature_implementation`, `draft_adr`, `refactor_impact_analysis`).

### `/chapters-note <action> [arguments...]`
Performs operations on notes:
- `/chapters-note read <vault-id> <path>`: Read note content and frontmatter.
- `/chapters-note create <vault-id> <path> [content]`: Create a new OKF note.
- `/chapters-note edit <vault-id> <path> <content>`: Update existing note content via CRDT.
- `/chapters-note rename <vault-id> <old-path> <new-path>`: Rename a note and refactor incoming wikilinks.
- `/chapters-note delete <vault-id> <path>`: Move note to trash.
- `/chapters-note history <vault-id> <path>`: View revision history and attribution.
- `/chapters-note revert <vault-id> <path> <revision-id>`: Revert to a previous revision.
- `/chapters-note audit [vault-id]`: Audit vault notes for OKF v0.2 conformance.

### `/chapters-repo <action> [arguments...]`
Performs operations on connected codebase repositories:
- `/chapters-repo list`: List all connected repositories.
- `/chapters-repo browse <repo-id> [path]`: Browse file and folder hierarchy.
- `/chapters-repo read <repo-id> <file-path>`: Read file content and AST symbol outline.
- `/chapters-repo status <repo-id>`: View sync freshness, commit SHA, and indexing status.
- `/chapters-repo sync <repo-id>`: Trigger an immediate repository sync.

### `/chapters-vault <action> [arguments...]`
Manages vaults and sharing:
- `/chapters-vault list`: List accessible vaults and permissions.
- `/chapters-vault browse <vault-id> [path]`: Browse notes hierarchy in a vault.
- `/chapters-vault create <name> [description]`: Create a new vault.
- `/chapters-vault preference <vault-id> [include true|false]`: View or set merged-graph preference.

### `/chapters-map <repo-id-or-path> [--vault <vault-id>] [--name <vault-name>]`
Maps an entire project or codebase repository into an interconnected, Open Knowledge Format (OKF v0.2) Knowledge Bundle within Chapters following the **5-Phase Flawless OKF Mapping Protocol** ([`references/codebase-mapping-protocol.md`](references/codebase-mapping-protocol.md)).

- **Workflow for Agents (The 5-Phase OKF Protocol)**:
  1. **Phase 0 — Target Binding & Ingestion Choice**:
     - **Vault Destination**: Ask if the codebase should be mapped in a new vault or an existing vault, and choose whether to name the vault or use the repository's name.
     - **Git Connection**: Ask if they also want to add/connect the repo to Chapters (`connect_repository`) for continuous background sync. When mapping a GitHub repository of any programming job, you must always map the codebase.
     - Bind to the target `vaultId`.
  2. **Phase 1 — Discovery & Manifest Analysis**:
     - Parse build manifests (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Dockerfile`).
     - Detect runtime engines, primary web/API frameworks, database/ORM layers, and all ingress boundaries.
  3. **Phase 2 — Architectural Domain Partitioning**:
     - Decompose the codebase into 4 to 8 cohesive bounded domains.
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
     - Call `audit_okf_conformance` to verify strict ISO 8601 UTC offsets, index presence, and zero orphan notes.
     - Call `graph` with `aggregate: "community"` to verify cohesive Louvain community clusters.
     - Call `search` to verify top-k hybrid search retrieval across all mapped domains.

### `/chapters-export <vault-id|note-path>`
Exports a vault zip archive or single note markdown file.
- **Tools called**: `export_vault`, `export_note`

---

## Chapters MCP Tool Reference (57 Tools)

Chapters exposes 57 tools across 7 functional domains:

### 1. Vault Management (14 tools)
| Tool | Scope | Description |
| :--- | :--- | :--- |
| `list_vaults` | Account | List all vaults accessible to the current user. |
| `create_vault` | Account | Create a new vault with name, description, and settings. |
| `browse_vault` | Vault/Account | Browse directory and note structure within a vault, with progressive disclosure (`path` and `recursive`). |
| `update_vault` | Vault/Account | Update vault name, description, or mergeable settings. |
| `get_vault_graph_preference` | Vault/Account | Get user's personal merged-graph inclusion preference. |
| `set_vault_graph_preference` | Vault/Account | Set user's personal merged-graph inclusion preference. |
| `get_vault_preferences` | Account | Get user vault preferences including storage mode (online/local), folders, colors, and favorites. |
| `update_vault_preferences` | Account | Update user vault preferences including storage mode, folders, colors, and favorites. |
| `delete_vault` | Vault/Account | Soft-delete a vault into trash (owner only). |
| `restore_vault` | Vault/Account | Restore a soft-deleted vault from trash. |
| `purge_vault` | Vault/Account | Permanently purge a trashed vault from disk and DB. |
| `list_vault_shares` | Vault/Account | List user and team shares for a vault. |
| `share_vault` | Vault/Account | Grant read or edit access to a user or team. |
| `revoke_vault_share` | Vault/Account | Revoke a user or team share from a vault. |

### 2. Note Operations & OKF Conformance (12 tools)
| Tool | Scope | Description |
| :--- | :--- | :--- |
| `read_note` | Vault/Account | Read note markdown content, frontmatter, and metadata. |
| `create_note` | Vault/Account | Create a new OKF note with unified `path` (or `type` and `name`) and frontmatter. |
| `edit_note` | Vault/Account | Update note content through CRDT live collaboration. |
| `rename_note` | Vault/Account | Rename or move a note within the vault with automatic wikilink refactoring. |
| `delete_note` | Vault/Account | Soft-delete a note to the vault trash. |
| `list_trash` | Vault/Account | List soft-deleted notes in the vault trash. |
| `restore_note` | Vault/Account | Restore a trashed note back to the vault. |
| `purge_note` | Vault/Account | Permanently delete a note and clean semantic edges. |
| `note_history` | Vault/Account | View revision history with user/AI attribution. |
| `revert_note` | Vault/Account | Revert a note to a prior revision without losing history. |
| `purge_revision` | Vault/Account | Permanently erase a recorded revision (owner only). |
| `audit_okf_conformance` | Vault/Account | Audit an OKF Knowledge Bundle vault for OKF v0.2 conformance (ISO 8601 UTC offsets, wikilinks, repo links, progressive disclosure, orphan notes). |

### 3. Repository & Codebase Mapping (13 tools)
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

### 4. Search & AST Code Symbols (2 tools)
| Tool | Scope | Description |
| :--- | :--- | :--- |
| `search` | Any | Hybrid search (lexical + semantic) across notes and code with `symbols` support. |
| `find_symbols` | Repo/Account | Fine-grained semantic and keyword search for AST code symbols (functions, classes, interfaces, types) with exact signatures and line ranges. |

### 5. Knowledge Graph & Perspectives (5 tools)
| Tool | Scope | Description |
| :--- | :--- | :--- |
| `graph` | Any | Query graph nodes, edges (extracted/structural/semantic), Louvain communities (`aggregate: "community"`). |
| `find_graph_path` | Any | Find shortest path connecting two concepts, notes, or code files in the knowledge graph. |
| `list_graph_perspectives` | Any | List saved graph perspectives and filter presets for a vault or merged graph. |
| `save_graph_perspective` | Vault/Account | Save a scoped graph perspective with filter presets (types, tags, date range, color mode). |
| `delete_graph_perspective` | Any | Delete a saved graph perspective by its ID. |

### 6. Teams & Users (7 tools)
| Tool | Scope | Description |
| :--- | :--- | :--- |
| `list_teams` | Account | List teams the user belongs to or manages. |
| `create_team` | Account | Create a new team. |
| `list_team_members` | Account | List members in a team. |
| `add_team_member` | Account | Add an active user to a team. |
| `remove_team_member` | Account | Remove a member from a team. |
| `delete_team` | Account | Delete a team. |
| `lookup_user` | Account | Look up an active user by exact email address. |

### 7. Export & Notifications (4 tools)
| Tool | Scope | Description |
| :--- | :--- | :--- |
| `export_vault` | Vault/Account | Export an entire vault as a zip archive. |
| `export_note` | Vault/Account | Export a single note as raw serialized markdown. |
| `list_notifications` | Account | List in-app notifications and activity feed. |
| `mark_notification_read` | Account | Mark a notification as read. |

---

## Chapters MCP Engineering Prompts (20 Prompts)

Chapters supports the Model Context Protocol Prompts standard with 20 pre-engineered prompts with context hydration:

| Prompt | Purpose |
| :--- | :--- |
| `active_project_companion` | Continuous session companion: anchors agent to project vault, capturing decisions in real time. |
| `sync_local_docs_to_vault` | Ingests local markdown notes into the Chapters vault. |
| `plan_feature_implementation` | Formulates grounded, zero-hallucination implementation plans from existing specs. |
| `prepare_task_context` | Bundles relevant notes, AST symbols, and graph context for an upcoming task. |
| `draft_adr` | Synthesizes an Architecture Decision Record (ADR) in strict OKF format. |
| `draft_rfc` | Generates a comprehensive Request for Comments (RFC) with rollout and risk plans. |
| `generate_api_spec` | Generates an OpenAPI/REST or MCP protocol specification from code entrypoints. |
| `explain_code_architecture` | Explains subsystem architecture, entrypoints, and invariants using the graph and AST symbols. |
| `onboard_subsystem` | Generates an accelerated onboarding guide for a specific domain. |
| `summarize_concept_chain` | Leverages `find_graph_path` to explain how two distinct concepts or code files connect. |
| `audit_architecture_drift` | Compares documented OKF specifications against actual code AST symbols. |
| `refactor_impact_analysis` | Traces backlinks, call sites, and graph dependencies to calculate refactor blast radius. |
| `audit_orphaned_code` | Identifies unlinked notes, unused AST symbols, and undocumented code. |
| `test_gap_analysis` | Audits core domain notes and specs against existing test suites. |
| `pr_review_against_specs` | Evaluates a PR or code change against established OKF architecture specifications. |
| `generate_release_notes` | Compiles release notes and technical changelog from recent notes, ADRs, and commits. |
| `audit_security_surface` | Analyzes ingress points, auth routes, and trust boundaries in the knowledge graph. |
| `database_schema_evolution` | Reviews data model notes and migration files for backward compatibility and index hygiene. |
| `supernode_bottleneck_audit` | Identifies graph supernodes (PageRank hotspots) indicating architectural tight coupling. |
| `incident_postmortem` | Structures a blameless post-mortem note referencing affected components and remediation tasks. |

See [`references/mcp-tools.md`](references/mcp-tools.md) for full parameter definitions and response structures.

---

## Platform Installation & Configuration Guides

### 1. Google Gemini & Antigravity
- **Antigravity CLI**:
  Configure in `~/.gemini/config/mcp_config.json`:
  ```json
  {
    "mcpServers": {
      "chapters": {
        "url": "https://chapters.piiix.org/mcp",
        "headers": {
          "Authorization": "Bearer YOUR_CHAPTERS_MCP_TOKEN"
        }
      }
    }
  }
  ```
  Install the agent skill:
  ```bash
  mkdir -p ~/.agents/skills/chapters && cp -r skills/chapters/* ~/.agents/skills/chapters/
  ```

### 2. Anthropic Claude (Claude Desktop & Claude Code)
- **Claude Desktop**:
  Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):
  ```json
  {
    "mcpServers": {
      "chapters": {
        "url": "https://chapters.piiix.org/mcp",
        "headers": {
          "Authorization": "Bearer YOUR_CHAPTERS_MCP_TOKEN"
        }
      }
    }
  }
  ```
- **Claude Code**:
  ```bash
  claude mcp add chapters https://chapters.piiix.org/mcp --header "Authorization: Bearer YOUR_CHAPTERS_MCP_TOKEN"
  mkdir -p ~/.claude/skills/chapters && cp -r skills/chapters/* ~/.claude/skills/chapters/
  ```

### 3. Cursor & Windsurf
- **Cursor**:
  1. Open **Cursor Settings** > **Features** > **MCP**.
  2. Click **+ Add New MCP Server**.
  3. Set Name: `chapters`, Type: `sse` or `http`, URL: `https://chapters.piiix.org/mcp`.
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
        "url": "https://chapters.piiix.org/mcp",
        "headers": {
          "Authorization": "Bearer YOUR_CHAPTERS_MCP_TOKEN"
        }
      }
    }
  }
  ```

---

## Keeping the Skill Always Active (Always-On Mode)

If you want your AI agent to keep Chapters **permanently active** across every session:

### One-Command Setup
Run the included installer script from the repository root:
```bash
./skills/chapters/scripts/install-always-on.sh all
```

### Manual Setup
- **Google Gemini / Antigravity**:
  Copy [`skills/chapters/rules/chapters.md`](rules/chapters.md) to `~/.gemini/config/rules/chapters.md` (or `~/.agents/rules/chapters.md`). It will be automatically injected into every conversation.
- **Anthropic Claude**:
  Append the contents of [`skills/chapters/rules/chapters.md`](rules/chapters.md) to `~/.claude/CLAUDE.md`.
- **Cursor**:
  Create `.cursor/rules/chapters.mdc` with `alwaysApply: true` and the contents of `rules/chapters.md`.
- **Windsurf**:
  Append the contents of `rules/chapters.md` to `.windsurfrules`.

*Note: Generate an MCP bearer token in the Chapters UI at `/settings` (Settings > MCP Connections) or through the Admin panel.*
