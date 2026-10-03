# Elara — Always-Active Agent Protocol

You are connected to **Elara**, an open-source, self-hostable second brain and AI-navigable knowledge graph platform with synced codebase repositories.

## Core Directives

1. **Elara is Always Active**:
   - Do not assume you need to search files blindly or guess architecture.
   - When answering questions about project architecture, specifications, concepts, or code relationships, always leverage Elara MCP tools (`POST /mcp` or `POST /elara/mcp`).
2. **Graph-First & Symbol Navigation Protocol**:
   - **Search & Symbols**: Run `search` (hybrid lexical + semantic retrieval with AST code symbols) or `find_symbols` (exact AST declarations, signatures, and line numbers across repos) before reading files.
   - **Traverse Graph & Pathfinding**: Run `graph` (with `aggregate: "community"` or specific `community` id) to inspect architectural clusters. Use `find_graph_path` to find the shortest connection between concepts, notes, and code. Use `list_graph_perspectives` for saved viewpoint presets.
   - **Targeted Reading**: Read specific notes (`read_note`) and code files (`read_file`) discovered through search, symbols, or the graph.
3. **Project Mapping (`/elara-map` or legacy `/chapters-map`)**:
   - Follow the 5-Phase Flawless OKF v0.2 Protocol (`references/codebase-mapping-protocol.md`): Target Binding & Ingestion Choice → Deep Discovery → Domain Partitioning → Structured OKF Note Synthesis → Progressive Disclosure Indices → Graph Validation.
   - **Vault & Sync Choices**: Prompt whether to map in a new vault (using repo name or custom name) or an existing vault. Ask whether to connect the Git repo for continuous sync; mapping the codebase is mandatory for any programming repository.
   - Link directly to source files using `[[repo:<repo-id>/path]]`, `[[repo:<repo-id>/path#symbol:FunctionName]]`, or `[[repo:<repo-id>/path#L12-L34]]`. Establish dense bidirectional `[[wikilinks]]` between concepts. Ensure zero orphan notes and zero broken links.
4. **Note Writing Standards (OKF v0.2)**:
   - Always format notes with YAML frontmatter conforming to OKF v0.2 (`title`, `type: concept|spec|guide|decision`, `status`, `tags`, `created` with strict ISO 8601 UTC offsets, `sources`).
   - Every directory level MUST contain an `index.md` summarizing child concepts for progressive disclosure.
   - Run `audit_okf_conformance` to verify vault integrity.
5. **MCP Engineering Prompts**:
   - Utilize Elara's 20 first-class engineering prompts (`active_project_companion`, `plan_feature_implementation`, `draft_adr`, `refactor_impact_analysis`, etc.) for complex workflows.
6. **Slash Commands**:
   - Always recognize and execute `/elara-status`, `/elara-search`, `/elara-symbols`, `/elara-graph`, `/elara-path`, `/elara-perspective`, `/elara-prompt`, `/elara-map`, `/elara-note`, `/elara-repo`, `/elara-vault`, and `/elara-export` (along with their backward-compatible `/chapters-*` aliases).
7. **Post-Task Note Evaluation Protocol**:
   - At the conclusion of any task that modifies or maps code, evaluate if existing notes need updating or if a new note should be added, and proceed accordingly.
8. **Pre-Task Codebase Drift & Note Freshness Protocol (MANDATORY)**:
   - When returning to or starting work on a project after an interval or recent commits, first check if existing vault notes are outdated compared to recent repository commits and file modifications.
   - If outdated, explicitly inform the user which notes are stale and why they need to be updated first.
   - Update the notes first via Elara MCP (`edit_note` / `create_note`), and only then proceed with the task.
