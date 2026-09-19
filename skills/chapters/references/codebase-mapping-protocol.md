# Chapters Flawless Codebase Mapping Protocol

This document defines the deterministic, 4-pass protocol for mapping any software project or codebase into an interconnected, AI-navigable knowledge graph within Chapters.

---

## 1. Core Principles of Flawless Mapping

A flawless codebase map is **not** a raw list of files or superficial summaries. It is an **executable mental model** structured into Google's Open Knowledge Format (OKF) with explicit graph edges:

1. **Architecture Over Inventory**: Focus on system responsibilities, domain boundaries, data flows, and invariants — not repetitive per-file descriptions.
2. **Direct Code Deep-Links**: Every concept, model, and flow must link directly to the implementation file using Chapters repository wikilinks: `[[repo:<repo-id>/path/to/file]]`.
3. **High-Density Bidirectional Wikilinks**: Concepts must link to related concepts (`[[concept-name]]`) so the Chapters graph engine generates meaningful community clusters and PageRank weights.
4. **Valid OKF Frontmatter**: Every note must carry valid YAML frontmatter with `title`, `type` (`concept`, `spec`, `decision`, `guide`), `tags`, and `status`.
5. **Zero Dead Links & Zero Orphans**: Every note must link to at least one other note, and all wikilinks must resolve cleanly.

---

## 2. The 4-Pass Mapping Algorithm

When executing `/chapters-map <repo-id-or-path> [--vault <vault-id>]`:

### Pass 1: Discovery & Manifest Analysis
1. **Analyze Manifests**:
   - Inspect build configurations and package definitions (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, `Dockerfile`, `docker-compose.yml`).
   - Identify language runtimes, primary frameworks (Fastify, React, Tokio, Django, etc.), databases (Postgres, SQLite, Redis), and key third-party libraries.
2. **Discover Entrypoints & Boundaries**:
   - Identify all external ingress points: HTTP routes, WebSockets, CLI entrypoints, background workers, event listeners, and cron jobs.
   - Identify storage layers, database schemas, migrations, and external network dependencies.

### Pass 2: Architectural Domain Partitioning
Partition the codebase into 4 to 8 cohesive architectural domains. Examples:
- **Core Domain & Business Logic**: State machines, rules, computational models.
- **Authentication & Security**: Tokens, sessions, RBAC, encryption, trust boundaries.
- **Data Persistence & Storage**: ORM, database tables, migrations, caching, disk storage.
- **Network & API Surface**: REST endpoints, MCP server, WebSocket relays, serialization.
- **User Interface & Interaction**: Component hierarchy, state stores, router, styles.
- **Infrastructure & Lifecycle**: Process management, background queues, telemetry.

For each domain, catalogue:
- The lead implementation files.
- The critical exported symbols (classes, functions, interfaces).
- Hard invariants and error-handling contracts.

### Pass 3: Structured OKF Note Generation
Ensure the target vault exists (via `list_vaults` / `create_vault`). Then generate notes in the vault:

#### A. Root Architecture Index (`index.md`)
The central entrypoint for human and AI navigation:
```markdown
---
title: "Project Architecture & Knowledge Map"
type: concept
tags: [architecture, overview, index]
created: YYYY-MM-DD
status: active
---

# Project Architecture & Knowledge Map

## System Overview
[Executive summary of what the system does, its design philosophy, and core problems solved.]

## Architectural Domains
- [[concepts/domain-1|Domain 1 Title]] — [One-line summary]
- [[concepts/domain-2|Domain 2 Title]] — [One-line summary]
- [[concepts/domain-3|Domain 3 Title]] — [One-line summary]

## Primary Entrypoints
- `[[repo:repo-id/src/index.ts]]` — Application bootstrap and HTTP listener.
- `[[repo:repo-id/src/mcp/server.ts]]` — Model Context Protocol (MCP) server.

## Data Flows & Specifications
- [[specs/core-data-flow|Core Data Flow & Lifecycle]]
- [[specs/security-model|Security & Permission Model]]

## Technology Stack
| Layer | Technology | Primary Files |
| :--- | :--- | :--- |
| Server / API | Fastify / Node.js | `[[repo:repo-id/src/app.ts]]` |
| Database | PostgreSQL + Drizzle ORM | `[[repo:repo-id/src/db/schema.ts]]` |
| AI / Graph | MCP + Graphology | `[[repo:repo-id/src/graph/assemble.ts]]` |
```

#### B. Domain Concept Notes (`concepts/<domain-name>.md`)
Create a note for each architectural domain:
```markdown
---
title: "Domain: Authentication & Access Control"
type: concept
tags: [auth, security, permissions]
created: YYYY-MM-DD
status: active
---

# Domain: Authentication & Access Control

## Responsibilities
[Detailed description of what this domain manages and enforces.]

## Key Invariants
- Sessions are strictly verified on every inbound request; no cross-request auth caching.
- Revocation takes effect immediately across all active connections.

## Key Files & Symbols
- `[[repo:repo-id/src/auth/session.ts]]` — Session token generation and validation.
- `[[repo:repo-id/src/auth/permissions.ts]]` — Permission resolution algorithm.

## Related Domains & Concepts
- [[concepts/database-storage|Database & Storage Layer]]
- [[concepts/mcp-server|MCP Server Access Scoping]]
```

#### C. End-to-End Flow Specifications (`specs/<flow-name>.md`)
Create flow notes for critical paths (e.g. data ingestion, live collaboration, request lifecycle):
```markdown
---
title: "Spec: Request Lifecycle & CRDT Write Path"
type: spec
tags: [spec, lifecycle, crdt, data-flow]
created: YYYY-MM-DD
status: active
---

# Spec: Request Lifecycle & CRDT Write Path

## Flow Sequence
1. Inbound mutation arrives via WebSocket relay (`[[repo:repo-id/src/collab/relay.ts]]`).
2. Authentication and permissions verified via [[concepts/auth-security|Auth System]].
3. Mutation applied to shared Yjs CRDT document.
4. Asynchronous persistence flushed to database (`[[repo:repo-id/src/notes/store.ts]]`).
```

### Pass 4: Graph Validation & Edge Audit
1. **Link Resolution Check**:
   - Inspect generated notes to confirm that every `[[note-title]]` matches an existing note path or title.
   - Verify every `[[repo:<repo-id>/path]]` matches an actual file in the repository.
2. **Graph Density & Topology Audit**:
   - Call `graph` with `aggregate: "community"` to inspect the community structure.
   - Verify that:
     - The generated notes form a connected graph with the code files.
     - There are no disconnected islands or isolated orphan notes.
     - Central hub notes (like `index.md`) have high degree centrality.
