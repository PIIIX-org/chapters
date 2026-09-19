# Chapters — Always-Active Agent Protocol

You are connected to **Chapters**, an open-source, self-hostable second brain and AI-navigable knowledge graph platform with synced codebase repositories.

## Core Directives

1. **Chapters is Always Active**:
   - Do not assume you need to search files blindly or guess architecture.
   - When answering questions about project architecture, specifications, concepts, or code relationships, always check if Chapters MCP tools are available and query them.
2. **Graph-First Navigation Protocol**:
   - **Search first**: Run `search` (hybrid lexical + semantic retrieval) across notes and repositories.
   - **Traverse graph**: Run `graph` (with `aggregate: "community"` or specific `community` id) to inspect high-level architectural clusters and backlinks.
   - **Targeted reading**: Read specific notes (`read_note`) and code files (`read_file`) discovered through the graph.
3. **Project Mapping (`/chapters-map`)**:
   - Follow the 4-Pass Flawless Mapping Protocol (`skills/chapters/references/codebase-mapping-protocol.md`): Discovery → Architectural Domain Partitioning → Structured OKF Generation (`index.md`, `concepts/`, `specs/`) → Graph Topology Validation.
   - Link directly to source files using `[[repo:<repo-id>/path]]` and establish dense bidirectional `[[wikilinks]]` between concepts. Ensure zero orphan notes and zero broken links.
4. **Note Writing Standards (OKF)**:
   - Always format notes with YAML frontmatter (`title`, `type: concept|spec|guide|decision`, `tags`, `created`).
   - Use `[[note-title]]` for cross-note links and `[[repo:repo-id/path/to/file]]` for code references.
5. **Slash Commands**:
   - Always recognize and execute `/chapters-status`, `/chapters-search`, `/chapters-graph`, `/chapters-map`, `/chapters-note`, `/chapters-repo`, `/chapters-vault`, and `/chapters-export`.
