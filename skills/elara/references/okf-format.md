# Open Knowledge Format (OKF v0.2) in Elara

How Elara stores, validates, and links notes in Google's **Open Knowledge Format (OKF v0.2)**. The rules marked "enforced" come from the server's validation in `server/src/notes/okf.ts` and `server/src/notes/okf/paths.ts`; a write that breaks them is refused.

Specification references:
- [GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format)

---

## 1. Core Rules

1. **Paths (enforced)**:
   - A note path is up to 8 slash-separated segments, for example `domains/storage/crdt/clock`. A trailing `.md` is accepted and stripped.
   - Every segment must match `^[a-z0-9][a-z0-9-]*$`: lowercase letters, digits, and hyphens, starting with a letter or digit. No uppercase, underscores, dots, or spaces. `decisions/adr-001-crdt-relay` is valid; `decisions/ADR-001` is not.
   - `.`/`..` segments, hidden segments, and leading, trailing, or double slashes are refused.

2. **`type` is the note's OKF type; the folder is the first path segment**:
   - `type` may be any non-empty string (OKF §4.1): `Metric`, `BigQuery Table`, `decision`. A note at `notes/adr-007` can have `type: decision`.
   - Left out (or empty), `type` is the first path segment: `create_note` at `specs/login-flow` without a `type` stores `type: specs`, and a root note such as `index` gets `type: index`. `edit_note` keeps the current `type` unless you set it; removing it (`removeKeys: ["type"]`) puts the folder back. Moving a note with `rename_note` (full path in `toName`) rewrites a `type` equal to the old folder to the new folder and keeps any other `type`; `revert_note` to a revision from before a move does the same with the folder the note had then.
   - The folder, not the frontmatter `type`, is the note's `type` field in replies and what the `types` filter of `search` (REST) and `graph`, and structural graph edges, match. The frontmatter `type` shows in `frontmatter` (reads, search hits) and in generated `index.md` tables. Filtering by the frontmatter `type` is not supported yet.

3. **Datetimes with an explicit offset (enforced)**:
   - `timestamp`, `stale_after`, `generated.at`, `verified.at`, `sources[].last_modified`, `usage_window.from`, and `usage_window.to` must be ISO 8601 datetimes with `Z` or an offset: `2026-09-22T12:00:00Z`, `2026-09-22T17:30:00+03:30`.
   - Bare dates (`2026-09-22`) and datetimes without an offset are refused.
   - `timestamp` defaults to the creation time when `create_note` doesn't set it.

4. **Frontmatter values (enforced)**:
   - `generated`, `sources`, `verified`, `usage_window`, and `properties` may hold objects (shapes in §3). Every other top-level key must be a scalar (string, number, boolean, null) or a list of scalars.
   - The note must survive being saved and read back. If its serialized file would parse to different frontmatter or body, the write is refused.
   - The frontmatter block in a file starts with a `---` line and ends at the first line that is exactly `---` (trailing spaces allowed). LF and CRLF files both parse. A `---` inside a value or in the body is content, not a fence.

5. **Progressive disclosure indexes**:
   - When notes are created, renamed, deleted, or restored, the server regenerates an `index.md` in each ancestor directory that lists its children.
   - If you write your own `<dir>/index` note, the server leaves that directory's index alone.
   - Agents can walk a vault level by level with `browse_vault` (`path`, without `recursive: true`).

6. **Provenance, trust, and lifecycle fields** (validated when present):
   - **`status`**: `draft`, `active`, `stable`, `deprecated`, `superseded`, or `archived`.
   - **`verified`**: object or list of objects with `tier` (`unverified`, `machine-confirmed`, `human-reviewed`), optional `by`, optional `at`.
   - **`generated`**: `{ by, at }`, both required.
   - **`sources`**: list of objects, each with a string `resource`; `id`, `title`, `last_modified`, `hash`, `author` are optional.
   - **`usage_window`**: `{ from, to? }`.

---

## 2. Knowledge Bundle Structure

In Elara a vault is an **OKF Knowledge Bundle**.

### 2.1 Typical Bundle Layout

```
vault-root/
├── index.md                      # Root index (type: index)
├── log.md                        # Optional changelog (type: log)
├── domains/                      # Subsystem notes (type: domains)
│   ├── index.md                  # Generated, or your own domains/index note
│   ├── auth-security/
│   │   ├── index.md              # Domain overview note
│   │   ├── session-lifecycle.md
│   │   └── permissions-matrix.md
│   └── api-surface/
│       ├── index.md
│       └── mcp-server.md
├── specs/                        # End-to-end flows (type: specs)
│   ├── index.md
│   ├── crdt-collaboration.md
│   └── repository-sync.md
├── models/                       # Data entities (type: models)
│   ├── index.md
│   └── vault.md
└── decisions/                    # ADRs (type: decisions)
    ├── index.md
    ├── adr-001-crdt-relay.md
    └── adr-002-single-process.md
```

### 2.2 Reserved Filenames

| Filename | Purpose |
| :--- | :--- |
| `index.md` | Directory summary. The server generates it; a note you write at `<dir>/index` replaces the generated table. |
| `log.md` | Optional chronological record of bundle updates and agent sessions. |

All other `.md` files are concept documents.

### 2.3 Index Tables

An `index.md` you write yourself can summarize child concepts in a table:

```markdown
# Authentication & Security Domain

## Child Concepts

| Concept | Description | Status | Code |
| :--- | :--- | :--- | :--- |
| [[domains/auth-security/session-lifecycle]] | Session validation and cookie lifecycle | active | [[repo:elara/server/src/auth/sessions.ts]] |
| [[domains/auth-security/permissions-matrix]] | Permission checks across vaults and repos | stable | [[repo:elara/server/src/vaults/permissions.ts]] |
```

---

## 3. Frontmatter Schema

Through MCP, frontmatter is passed to `create_note` / `edit_note` as a JSON object (`frontmatter`), separate from the markdown `body`. On disk it is the YAML block at the top of the file:

```yaml
---
# === Identity ===
type: domains                       # REQUIRED in OKF; any non-empty string. Defaults to the first path segment.
title: "Authentication & Security"  # Display title.
description: "Handles user sessions, MFA verification, and permission checks." # One-sentence summary.

# === Resource & time ===
resource: "repo:elara/server/src/auth" # String; the asset this note describes.
tags: [auth, security, sessions]       # List of strings.
timestamp: "2026-09-22T05:00:00Z"      # Defaults to creation time. Explicit offset required.
stale_after: "2026-12-31T23:59:59Z"    # Optional. Explicit offset required.

# === Lifecycle & trust ===
status: active                      # draft | active | stable | deprecated | superseded | archived
verified:
  tier: human-reviewed              # unverified | machine-confirmed | human-reviewed
  by: "human:taha"
  at: "2026-09-22T05:00:00Z"

# === Provenance ===
generated:
  by: "agent:claude"
  at: "2026-09-22T05:00:00Z"
sources:
  - id: auth-sessions
    resource: "repo:elara/server/src/auth/sessions.ts"
    title: "Session handling"
    last_modified: "2026-09-21T18:00:00Z"

# === Optional ===
usage_window:
  from: "2026-09-22T00:00:00Z"
  to: "2027-09-22T00:00:00Z"
properties:
  layer: backend
  owner: "Core Team"
---
```

### 3.1 Field Notes

- **`type`**: the kind of concept, free text (`Metric`, `Policy`, `decision`). The folder (first path segment) groups notes and is what the `types` filter matches; `type` defaults to it when left out.
- **`description`**: one dense sentence; shown in search snippets and index tables.
- **`resource`**: a string such as `repo:<repo>/server/src/auth/sessions.ts` or an external URL. It is metadata only; it does not create a graph edge. Put a bare `[[repo:...]]` link in the body for that.
- **`timestamp`**: creation or modification time with an explicit offset. A key named `created` is not treated as a datetime; use `timestamp`.
- **`generated`** / **`sources`**: who produced the note and from which artifacts.
- **`verified`**: how much the note can be trusted. A single object or a list.

---

## 4. Body Conventions

Prefer structured markdown over prose:

```markdown
# [Concept Display Title]

## Overview & Scope
[2-3 paragraphs: boundary, responsibilities, rationale.]

## Architecture & Components
[Subcomponents and module boundaries.]

## Key Invariants & Contracts
- Rules that must never break (concurrency, security, transaction boundaries).
- Error conditions and fallbacks.

## Data Flow & State Transitions
[Step-by-step lifecycle.]

## Key Implementation Files
- [[repo:<repo>/path/to/lead-file.ts]] — Lead implementation.
- [[repo:<repo>/path/to/types.ts]] — Core interfaces and exported types.

## Related Concepts & Domains
- [[domains/other-domain/index|Other Domain Title]] — Relationship.
- [[specs/workflow-spec|Relevant Workflow Spec]] — End-to-end interaction.
- [[decisions/adr-001-crdt-relay|Governing Architecture Decision]] — Context.
```

Write links bare, as above. A link wrapped in backticks is code, not a link.

---

## 5. Wikilinks & Graph Edges

Elara turns links in the note body into `extracted` edges in the graph.

### 5.1 Note-to-Note Links
- `[[domains/auth-security/session-lifecycle]]`: directed edge to the target note. Prefer the full path: `rename_note` rewrites full-path links when the target moves, but not bare-name links like `[[session-lifecycle]]`.
- `[[domains/auth-security/session-lifecycle|Session Management]]`: same edge, shown with a label.
- `[[domains/auth-security/session-lifecycle#Revocation Flow]]`: same edge; the heading anchor is for display.

### 5.2 Note-to-Code Links
- `[[repo:<repo-name-or-id>/path/to/file.ext]]`: edge from the note to that file of a repository you can access, for example `[[repo:elara/server/src/mcp/server.ts]]`.
- `[[repo:<repo>/path/to/file.ext#L45-L75]]`: accepted; the edge still points at the file. The audit checks that the file exists, not the line range.

### 5.3 What Is Ignored
Links inside inline code (`` `...` ``), fenced code blocks, and HTML comments are stripped before extraction. They create no edge, and the audit does not see them.

### 5.4 Structural & Semantic Edges
- **`structural`**: created automatically between notes sharing a `type` or a tag (and between code files sharing a language or top-level directory). Groups larger than 50 are skipped.
- **`semantic`**: created automatically between nodes with high embedding similarity.

---

## 6. Examples

### 6.1 Domain Note (`domains/auth-security/index`)

`create_note` arguments: `path: "domains/auth-security/index"`, plus this frontmatter and body. As a file:

```markdown
---
type: domains
title: "Authentication, Authorization & Session Security"
description: "Sessions, multi-factor authentication, and live permission checks across REST, MCP, and collaboration sockets."
resource: "repo:elara/server/src/auth"
tags: [architecture, auth, security, mfa, permissions]
status: active
timestamp: "2026-09-22T05:00:00Z"
generated:
  by: "agent:claude"
  at: "2026-09-22T05:00:00Z"
sources:
  - id: auth-sessions
    resource: "repo:elara/server/src/auth/sessions.ts"
    title: "Session handling"
  - id: vault-permissions
    resource: "repo:elara/server/src/vaults/permissions.ts"
    title: "Vault access resolution"
properties:
  layer: backend
---

# Authentication, Authorization & Session Security

## Overview & Scope
Governs identity, sessions, and access checks. Access is re-resolved from the database on every request, so revoking a share takes effect on the next call.

## Key Invariants
- MCP bearer tokens are stored only as hashes; a lost token cannot be recovered, only revoked and reissued.
- Revoking access to a vault or repository disconnects live collaboration sockets.
- Lockout counters are kept in memory per instance.

## Key Implementation Files
- [[repo:elara/server/src/auth/sessions.ts]] — Session handling.
- [[repo:elara/server/src/auth/passwords.ts]] — Password hashing.
- [[repo:elara/server/src/auth/mfa.ts]] — TOTP verification and backup codes.
- [[repo:elara/server/src/vaults/permissions.ts]] — Vault access resolution.

## Related
- [[specs/crdt-collaboration|Real-time collaboration and permission enforcement]]
- [[decisions/adr-004-oidc-sso|ADR 004: OIDC single sign-on]]
```

### 6.2 Workflow Spec (`specs/crdt-collaboration`)

```markdown
---
type: specs
title: "Real-Time Collaborative Editing"
description: "Ticket issue, WebSocket handshake, Yjs sync, and permission enforcement for live note editing."
resource: "repo:elara/server/src/sync/collab-server.ts"
tags: [spec, collab, crdt, yjs, websockets]
status: active
timestamp: "2026-09-22T05:00:00Z"
sources:
  - id: collab-server
    resource: "repo:elara/server/src/sync/collab-server.ts"
    title: "Hocuspocus collaboration server"
---

# Real-Time Collaborative Editing

## Overview
Notes are edited together as Yjs documents synced over a Hocuspocus WebSocket relay. The server checks permissions on the socket and writes the document back to the note file.

## Sequence
1. **Ticket**: the client calls `POST /api/collab/ticket` and receives a single-use token and the socket path `/collab`.
2. **Handshake**: the client opens the socket with the ticket; the server checks that the user has edit access to the note's vault, and re-checks access on every inbound message.
3. **Sync**: client and server exchange Yjs state and missing updates.
4. **Presence**: cursor positions are broadcast to other editors.
5. **Persistence**: the server debounces changes and writes frontmatter and body to the note file.

## Key Files
- [[repo:elara/server/src/sync/collab-server.ts]] — Collaboration server and access checks.
- [[repo:elara/server/src/sync/tickets.ts]] — Single-use tickets.
- [[repo:elara/client/src/hooks/useCodeMirrorEditor.ts]] — Client-side Yjs and CodeMirror binding.
```
