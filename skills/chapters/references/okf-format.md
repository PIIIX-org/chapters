# Open Knowledge Format (OKF v0.2) in Chapters

This specification defines the implementation and conventions of Google's **Open Knowledge Format (OKF v0.2)** within Chapters.

Chapters was engineered specifically to store, link, and serve notes in OKF so that both human engineers and autonomous AI agents can navigate, retrieve, and reason over software systems and team knowledge with minimal token waste and maximum topological fidelity.

Specification references:
- [GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format)

---

## 1. Core Principles & OKF v0.2 Updates

OKF v0.2 introduces four major architectural pillars to standard markdown knowledge bases:

1. **Mandatory Strict ISO 8601 UTC / Offset Datetimes**:
   All datetime fields (`timestamp`, `stale_after`, `generated.at`, `verified.at`, `sources[].last_modified`, `usage_window.from`, `usage_window.to`) MUST be formatted with an explicit UTC or timezone offset:
   - Pattern: `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/`
   - Valid examples: `2026-09-22T12:00:00Z`, `2026-09-22T08:30:00+00:00`, `2026-09-22T17:30:00+03:30`
   - Bare calendar dates (e.g. `2026-09-22`) and timestamps without explicit timezone offsets are rejected by server validation and flagged in UI inspection.

2. **8-Level Arbitrary Directory Hierarchy**:
   Rather than being constrained to a single flat `type/name` folder structure, OKF v0.2 notes support arbitrary nested directory structures up to 8 levels deep (e.g. `domains/storage/crdt/vectors/clock.md`). Path segments must be valid slugs (`^[a-z0-9][a-z0-9-]*$`), guaranteeing safe filesystem mapping and preventing path traversal.

3. **Progressive Disclosure Index Tables**:
   Every directory level in an OKF bundle must contain an `index.md` file that summarizes the immediate directory, lists child subdirectories with counts, and provides a markdown summary table of child concepts. AI agents can traverse deep knowledge trees progressively via `browse_vault` (`path` and `recursive: false`) without overflowing LLM context windows.

4. **Structured Provenance, Trust & Lifecycle**:
   OKF v0.2 establishes first-class frontmatter schemas for tracking provenance, trust, and lifecycles:
   - **`status`**: Lifecycle state of the note (`draft`, `active`, `stable`, `deprecated`, `superseded`, `archived`).
   - **`verified`**: Trust tier metadata (`unverified`, `machine-confirmed`, `human-reviewed`), including reviewer identity (`by`) and verification timestamp (`at`).
   - **`generated`**: Agent or automated pipeline attribution (`by`) and generation timestamp (`at`).
   - **`sources`**: Dependency list of underlying source artifacts (`id`, `resource`, `title`, `last_modified`, `hash`, `author`) for automated staleness tracking.
   - **`usage_window`**: Temporal validity interval (`from`, `to`).

---

## 2. Knowledge Bundle Structure & Progressive Disclosure

In Chapters, a vault represents an **OKF Knowledge Bundle**: a self-contained, version-controlled collection of knowledge documents.

### 2.1 Standard Bundle Directory Layout

```
vault-root/
├── index.md                      # Bundle Root Index: High-level system overview & domain catalog
├── log.md                        # Optional: Chronological changelog of updates and agent sessions
├── domains/                      # Architectural domains and subsystem concept notes (up to 8 levels)
│   ├── index.md                  # Domain index (progressive disclosure)
│   ├── auth-security/
│   │   ├── index.md              # Domain overview note
│   │   ├── session-lifecycle.md  # Specific concept note
│   │   └── permissions-matrix.md # Specific concept note
│   ├── data-storage/
│   │   ├── index.md
│   │   └── schema-design.md
│   └── api-surface/
│       ├── index.md
│       └── mcp-server.md
├── specs/                        # End-to-end workflow specifications and data pipelines
│   ├── index.md                  # Workflow specs index
│   ├── crdt-collaboration.md     # Specific workflow spec
│   └── repository-sync.md
├── models/                       # Data entities, database schemas, and API contracts
│   ├── index.md                  # Models index
│   ├── vault.md
│   └── semantic-edge.md
└── decisions/                    # Architecture Decision Records (ADRs)
    ├── index.md                  # ADR index
    ├── ADR-001-crdt-relay.md
    └── ADR-002-single-process.md
```

### 2.2 Reserved Filenames

| Filename | Purpose & Rules |
| :--- | :--- |
| `index.md` | **Directory Listing & Progressive Disclosure**: Summarizes the immediate folder, lists child concepts with descriptions in markdown index tables, and provides links to child subdirectories. Never used for leaf concept documentation. |
| `log.md` | **Update History & Audit Trail**: Chronological record of bundle updates, agent mapping sessions, and milestone revisions. |

All other `.md` files represent **Concept Documents**.

### 2.3 Progressive Disclosure Index Tables

Every `index.md` summarizes child concepts using structured markdown tables so AI agents can query high-density summaries before loading individual notes:

```markdown
# Authentication & Security Domain

## Child Concepts

| Concept | Description | Status | Resource |
| :--- | :--- | :--- | :--- |
| [[session-lifecycle]] | Session validation and cookie encryption lifecycle | active | `repo:chapters/server/src/auth/session.ts` |
| [[permissions-matrix]] | RBAC permission evaluation across vaults and repos | stable | `repo:chapters/server/src/auth/permissions.ts` |
| [[mfa-spec]] | TOTP authentication and backup code management | active | `repo:chapters/server/src/auth/mfa.ts` |
```

---

## 3. Concept Document Frontmatter Schema

Every concept document must contain a YAML frontmatter block at the very top conforming to OKF v0.2:

```yaml
---
# === Core Identity (Required) ===
type: Architectural Domain          # REQUIRED. Short string naming the concept category.
title: "Authentication & Security"  # Recommended display title.
description: "Handles user sessions, MFA verification, and RBAC token resolution." # Single-sentence summary for indices and agent search.

# === Resource Binding & Timestamp ===
resource: "repo:chapters/server/src/auth" # Canonical URI or repo deep-link identifying the underlying code asset.
tags: [auth, security, sessions, rbac]     # Cross-cutting categorization tags.
timestamp: "2026-09-22T05:00:00Z"          # REQUIRED ISO 8601 UTC timestamp with explicit offset.
stale_after: "2026-12-31T23:59:59Z"        # Optional ISO 8601 UTC expiration timestamp.

# === Lifecycle & Trust (Optional) ===
status: active                      # draft | active | deprecated | superseded | archived | stable
verified:
  tier: human-reviewed              # unverified | machine-confirmed | human-reviewed
  by: "human:taha"                  # Actor convention (human:<id>, agent:<name>, process:<id>)
  at: "2026-09-22T05:00:00Z"        # ISO 8601 UTC timestamp

# === Provenance & Attribution (Optional) ===
generated:
  by: "agent:antigravity"           # Agent or process that generated this note
  at: "2026-09-22T05:00:00Z"        # ISO 8601 UTC timestamp
sources:
  - id: auth-session-ts
    resource: "repo:chapters/server/src/auth/session.ts"
    title: "Session Manager Implementation"
    last_modified: "2026-09-21T18:00:00Z" # ISO 8601 UTC timestamp
  - id: mfa-spec
    resource: "docs/superpowers/specs/2026-07-15-mfa-design.md"
    title: "MFA Architecture Specification"

# === Temporal Window & Custom Properties (Optional) ===
usage_window:
  from: "2026-09-22T00:00:00Z"
  to: "2027-09-22T00:00:00Z"
properties:
  complexity: high
  layer: backend
  owner: "Core Team"
---
```

### 3.1 Field Specifications

#### `type` (REQUIRED)
Identifies the kind of concept for routing, search filtering, and graph community detection. Recommended standard types:
- `System Architecture`: High-level system overview, root maps, and cross-cutting blueprints.
- `Architectural Domain`: A cohesive subsystem or functional module (e.g. Auth, Storage, Client).
- `Workflow Spec`: An end-to-end execution path, lifecycle, or multi-step data flow.
- `Data Model`: Database table, entity definition, or schema contract.
- `API Contract`: REST route, MCP tool schema, or WebSocket protocol.
- `Architecture Decision`: Formal Architecture Decision Record (ADR).
- `Component Guide`: UI component, editor extension, or frontend layout.
- `Reference`: Environment configurations, operational runbooks, or cheat sheets.

#### `description` (RECOMMENDED)
A single, high-density sentence summarizing what the concept is and does. Chapters uses this field for search snippet previews, `index.md` progressive disclosure tables, and prompt injection for LLM context windows.

#### `resource` (RECOMMENDED FOR CODE-LINKED CONCEPTS)
A URI that uniquely identifies the underlying asset the concept describes:
- Repository file or folder: `repo:<repo-id>/server/src/auth/session.ts`
- External specification: `https://github.com/GoogleCloudPlatform/open-knowledge-format`

#### `timestamp` (STRICT ISO 8601 WITH OFFSET)
Records creation or modification datetime. Must match `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/`.

#### `status` (LIFECYCLE)
One of `draft`, `active`, `stable`, `deprecated`, `superseded`, `archived`. Rendered in UI as semantic status badge with color-coded dot.

#### `generated` & `sources` (PROVENANCE FAMILY)
- `generated`: Records who produced the note (`by`) and when (`at: "<ISO-8601 UTC>"`).
- `sources`: An array of concrete artifacts (code files, specs, configs) that the note was synthesized from, each with `id`, `resource`, `title`, and optional `last_modified` (ISO 8601 UTC).

#### `verified` (TRUST TIER FAMILY)
Records how much trust an agent or human can place in the note:
- `unverified`: Machine-extracted without verification.
- `machine-confirmed`: Validated against test runs, linter, or compiler output.
- `human-reviewed`: Explicitly reviewed and signed off by a human engineer.
Can be specified as a single object or an array of verification records.

---

## 4. Concept Document Body Conventions

To maximize readability for both humans and AI retrieval models, OKF concept documents favor structured markdown over conversational prose.

### Recommended Heading Structure

```markdown
# [Concept Display Title]

## Overview & Scope
[2-3 paragraphs defining the boundary, primary responsibilities, and architectural rationale.]

## Architecture & Components
[Structured breakdown of subcomponents, responsibilities, and module boundaries.]

## Key Invariants & Contracts
- Non-negotiable system rules (e.g. concurrency guarantees, security constraints, transaction boundaries).
- Error conditions and fallback behaviors.

## Data Flow & State Transitions
[Step-by-step sequential lifecycle, state machine, or data progression.]

## Key Implementation Files
- `[[repo:<repo-id>/path/to/lead-file.ts]]` — Description of lead implementation.
- `[[repo:<repo-id>/path/to/types.ts]]` — Core interfaces and exported types.

## Related Concepts & Domains
- [[domains/other-domain/index|Other Domain Title]] — Relationship explanation.
- [[specs/workflow-spec|Relevant Workflow Spec]] — End-to-end interaction.
- [[decisions/ADR-001|Governing Architecture Decision]] — Contextual decision.
```

---

## 5. Chapters Wikilinks & Graph Edge Resolution

Chapters transforms markdown links and wikilinks into explicit graph edges in the knowledge graph:

### 5.1 Note-to-Note Links (`EXTRACTED` Edges)
- **Standard Link**: `[[concepts/session-lifecycle]]` or `[[session-lifecycle]]`
  - Creates a directed edge from the current note to the target note.
- **Aliased Link**: `[[concepts/session-lifecycle|Session Management Engine]]`
  - Displays as "Session Management Engine" in the text while resolving the target note path.
- **Heading Anchor**: `[[concepts/session-lifecycle#Revocation Flow]]`
  - Deep-links to a specific section heading within the target note.

### 5.2 Repository / Codebase Deep-Links (`EXTRACTED` Cross-Domain Edges)
- **File Link**: `[[repo:<repo-id>/path/to/file.ext]]`
  - Links the note directly to an ingested repository file in the Chapters graph.
  - Example: `[[repo:chapters/server/src/mcp/server.ts]]`
- **Line Range Link**: `[[repo:<repo-id>/path/to/file.ext#L45-L75]]`
  - Deep-links to a specific line range within the code viewer.
  - Example: `[[repo:chapters/client/src/components/shell/Rail.tsx#L39-L65]]`

### 5.3 Semantic & Structural Edges
- **Structural Edges**: Created automatically by Chapters between notes sharing the same `type` or overlapping `tags`.
- **Semantic Edges**: Generated automatically by the Chapters vector engine between notes with high cosine similarity in their embedding space.

---

## 6. Concrete OKF Note Examples

### 6.1 Architectural Domain Concept (`domains/auth-security/index.md`)

```markdown
---
type: Architectural Domain
title: "Authentication, Authorization & Session Security"
description: "Provides multi-factor authentication, secure session tokens, and instant permission revocation across REST and WebSocket streams."
resource: "repo:chapters/server/src/auth"
tags: [architecture, auth, security, mfa, permissions]
status: active
generated:
  by: "agent:antigravity"
  at: "2026-09-22T05:00:00Z"
verified:
  tier: human-reviewed
  by: "human:taha"
  at: "2026-09-22T05:00:00Z"
sources:
  - id: auth-store
    resource: "repo:chapters/server/src/auth/store.ts"
    title: "Auth Database Store"
  - id: session-middleware
    resource: "repo:chapters/server/src/auth/session.ts"
    title: "Fastify Session Middleware"
properties:
  layer: backend
  owner: "Security Guild"
---

# Authentication, Authorization & Session Security

## Overview & Scope
The Authentication & Security domain governs identity verification, token lifecycle, and cryptographic trust boundaries for Chapters. It guarantees that unauthenticated requests cannot access note contents, and ensures that privilege revocation terminates active sessions immediately.

## Key Invariants
- **Zero Content Leakage on Auth Failure**: Authentication errors return generic "invalid credentials" to prevent account enumeration.
- **Immediate Revocation Kick**: Revoking access to a vault or repository publishes a real-time event that terminates active CRDT WebSocket connections within 50ms.
- **Single-Process Counter Guarantees**: Brute-force lockout counters are maintained in-memory per instance.

## Key Implementation Files
- `[[repo:chapters/server/src/auth/session.ts]]` — Session extraction and cookie verification.
- `[[repo:chapters/server/src/auth/store.ts]]` — Argon2id password hashing and user row persistence.
- `[[repo:chapters/server/src/auth/mfa.ts]]` — TOTP generation, verification, and backup code hashing.

## Related Concepts & Workflows
- [[specs/collaboration-relay|Real-time Collaboration & Permission Enforcement]]
- [[domains/admin-oversight/index|Admin Oversight & Security Audit Trail]]
- [[decisions/ADR-004-oidc-sso|ADR 004: Generic OIDC Single Sign-On Integration]]
```

### 6.2 Workflow Specification (`specs/crdt-collaboration.md`)

```markdown
---
type: Workflow Spec
title: "Real-Time Collaborative Editing via CRDT Relay"
description: "Specifies the WebSocket connection handshake, Yjs document synchronization, and mid-session revocation enforcement."
resource: "repo:chapters/server/src/collab/relay.ts"
tags: [spec, collab, crdt, yjs, websockets]
status: active
generated:
  by: "agent:antigravity"
  at: "2026-09-22T05:00:00Z"
sources:
  - id: collab-relay
    resource: "repo:chapters/server/src/collab/relay.ts"
    title: "Hocuspocus Server Relay"
---

# Real-Time Collaborative Editing via CRDT Relay

## Overview
Chapters implements collaborative note editing using Yjs CRDTs synchronized over a Hocuspocus WebSocket relay. The server acts as a state authority, validating permissions on every transaction and persisting updates to the disk storage layer.

## Step-by-Step Sequence
1. **Ticket Acquisition**: Client calls `POST /api/vaults/:id/notes/:path/collab/ticket`.
2. **Permission Check**: Server confirms caller holds `edit` permission on the vault.
3. **WebSocket Handshake**: Client upgrades connection to `ws://host/collab` presenting the single-use ticket.
4. **CRDT Sync**: Client and server exchange Yjs state vectors and sync missing updates.
5. **Presence Broadcast**: Client cursor position and user ink color are broadcast to active peers.
6. **Persistence**: Server debounces document flush and commits markdown + frontmatter to the filesystem.

## Key Files
- `[[repo:chapters/server/src/collab/relay.ts]]` — Hocuspocus server setup and ticket validation.
- `[[repo:chapters/client/src/hooks/useCodeMirrorEditor.ts]]` — Client-side Yjs and CodeMirror 6 binding.
```
