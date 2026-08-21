# Chapters — Backend Reference

A full technical reference for the backend: what was built, how it
works, every piece of technology involved, and how to maintain it. This
is the deep-dive companion to the other files in `docs/agents/`:

- `brief.md` — what Chapters is and why, one page.
- `STATE.md` — where the project is *right now*, resume anchor.
- `implementation.md` — the operating prompt agents follow while
  building (stack decisions, structure rules, performance budgets).
- `handling-protocols.md` / `github-workflow.md` — how work gets done
  (testing discipline, branch/PR/promotion cycle).
- **This file** — how the backend actually works, end to end, for
  whoever (human or agent) needs to maintain, extend, or debug it.

The design specs (`docs/superpowers/specs/`) are the source of truth for
*intent*; this file documents the *implementation* as it exists in the
code today, including places where reality is more nuanced than the
spec's one-line description.

---

## 1. Architecture at a glance

One deployment = one Node.js process = one organization. Two listeners:

- **Main HTTP API** (Fastify) — `PORT`, default `3000`. Everything
  except live collaboration.
- **Collaboration relay** (Hocuspocus/Yjs) — `COLLAB_PORT`, default
  `3001`. Runs in the same process, started right after the HTTP server
  (`server/src/index.ts`).

```
                 ┌─────────────────────────────────────┐
                 │            one Node process          │
  HTTP :3000 ───▶│  Fastify API (REST + MCP)             │
                 │  Hocuspocus relay :3001 (Yjs CRDT)     │
                 │  in-process queues/buses (§9)          │
                 └───────────────┬───────────────────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                                ▼
        PostgreSQL (+pgvector)              OKF markdown files
        derived index only:                 on disk (DATA_DIR)
        accounts, shares, sessions,         canonical source of
        FTS/embedding index,                truth for note content
        security/audit logs,
        notifications, code index
```

**The database is a derived index, not the source of truth for notes.**
Every note is a plain OKF (Open Knowledge Format: markdown + YAML
frontmatter) file on disk at `DATA_DIR/vaults/<vaultId>/<type>/<name>.md`.
The `notes` table mirrors it (frontmatter, body, full-text/embedding
columns) so Postgres can be queried efficiently, but `readNote()` always
reads the file, and the whole table is rebuildable from the file tree if
it were ever lost. Repositories (codebase mapping) follow the same
principle in reverse: git itself is the source of truth, and
`repositoryFiles` is a fully disposable index — file rows are **hard**
deleted and recreated on every sync, no trash, because "git remains the
record of code history, not Chapters."

**Permissions are always resolved live**, never cached across a
request or a connection. `resolveAccess()` (vaults) and
`resolveRepositoryAccess()` (repositories) hit the database on every
single call — REST route, MCP tool call, and even *per inbound Yjs
message* on an open collaboration socket. This is a deliberate,
spec-mandated trade-off (cost of a query vs. the risk of stale
authorization) and it's why revoking a share kicks a live editing
session within one message round-trip instead of waiting for
reconnect.

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, strict mode, everywhere (server + eventual client) | best AI navigability — see `docs/superpowers/specs/2026-07-17-tech-stack-decision.md` |
| Runtime | Node.js ≥ 24, run via `tsx` (no separate build/compile step, dev and prod alike) | one execution path to reason about; `tsc --noEmit` is typecheck-only |
| HTTP API | Fastify 5 | plugin architecture matches the "one process, many subsystems registered as plugins" shape |
| Real-time collab | `@hocuspocus/server` 4 (Yjs CRDT relay) | off-the-shelf CRDT sync server with auth/document lifecycle hooks |
| Database | PostgreSQL 17 (`pgvector/pgvector:pg17` image) | one datastore for relational data, full-text search, and vector search |
| Vector search | pgvector extension, HNSW indexes, cosine distance (`<=>`) | avoids a separate vector database |
| Full-text search | native Postgres `tsvector`/GIN (generated columns) | no separate search engine (Elasticsearch etc.) for a single-instance app |
| ORM / migrations | Drizzle ORM + `drizzle-kit generate`, hand-edited SQL for vector/FTS/HNSW extras Drizzle can't express | typed queries, SQL-level control when needed |
| Embeddings | Transformers.js (`@huggingface/transformers`) running `Xenova/bge-small-en-v1.5` fully local via ONNX | notes/code never leave the instance; no external API dependency |
| Code parsing | `web-tree-sitter` (WASM) + per-language grammar packages (TS, JS, Python, Go) | native `tree-sitter` bindings fail to compile against current Node's V8 headers (see §11); WASM sidesteps native compilation entirely |
| Graph analysis | `graphology` + `graphology-communities-louvain` | community detection (Louvain now, Leiden tracked as a future upgrade) |
| AI access | `@modelcontextprotocol/sdk`, Streamable HTTP transport | official SDK, stateless-per-request transport (no server-side session state to leak across connections) |
| Auth | `@node-rs/argon2` (passwords), `otpauth` (TOTP/MFA), Node `crypto` (session/reset tokens, SHA-256 hashed at rest) | |
| Repository credentials | AES-256-GCM (Node `crypto`), `CREDENTIALS_ENCRYPTION_KEY` env var | reversible (unlike hashed tokens) — a stored git credential must be usable again on the next pull |
| Git ingestion | `simple-git` | shallow clone (`--depth 1`) into a scratch temp dir per sync, discarded after reading |
| Local-path ingestion | `chokidar` | real-time filesystem watch |
| Email | `nodemailer`, optional (falls back to an in-memory capture array if `SMTP_HOST` unset) | notifications work in dev/test with zero mail infra |
| Validation | `zod` | MCP tool input schemas |
| Security headers | `@fastify/helmet` | on unconditionally |
| CORS | `@fastify/cors`, only registered if `CORS_ORIGIN` is set | same-origin-only is the correct default for a self-hosted, reverse-proxied app |
| Tooling | pnpm workspaces, Vitest, ESLint + `typescript-eslint` + Prettier, Docker/Docker Compose, GitHub Actions CI, Dependabot | |

---

## 3. Project structure

```
chapters/
├── Dockerfile, .dockerignore       # app image (Debian-based — see §10)
├── docker-compose.yml              # dev/test Postgres (pgvector/pgvector:pg17)
├── docs/
│   ├── agents/                     # operating docs (this folder)
│   └── superpowers/
│       ├── plans/                  # one implementation plan per sub-project
│       └── specs/                  # design specs — source of truth for intent
├── server/
│   ├── .env.example                # every env var, documented, in one place
│   ├── src/
│   │   ├── app.ts                  # Fastify assembly: plugin/route registration order
│   │   ├── index.ts                # entry point — boots HTTP API + collab relay
│   │   ├── config.ts               # single source for all env-derived config
│   │   ├── db/                     # Drizzle schema + migrations + client
│   │   ├── auth/                   # sessions, passwords, lockout, MFA, admin, bootstrap
│   │   ├── vaults/                 # vaults, sharing, teams, MCP connection management
│   │   ├── notes/                  # OKF file storage, validation, the note write path
│   │   ├── notifications/          # single notify() write path + routes
│   │   ├── graph/                  # buildGraph() — the one graph assembly function
│   │   ├── search/                 # hybrid search, embeddings, embedding queue, semantic edges
│   │   ├── sync/                   # Hocuspocus relay, permission-event bus, SSE viewers
│   │   ├── mcp/                    # MCP server, tools, rate limiting, CRDT-aware writes
│   │   ├── export/                 # backup/restore, vault export, share links, import
│   │   ├── repositories/           # codebase ingestion (git/local/agent-push), extraction
│   │   ├── email/                  # nodemailer wrapper
│   │   └── scripts/                # CLI entry points (reindex, restore-backup)
│   └── test/                       # one file per subsystem, Vitest
├── shared/                         # types shared server ↔ client (UI phase, not started)
└── client/                         # React + Vite (UI phase — do not start yet)
```

Rule of thumb: one responsibility per file, files that change together
live together. `shared/` holds only cross-cutting types, never logic.

---

## 4. Data model

Every table lives in `server/src/db/schema.ts`, migrated via
`drizzle-kit generate` (plus hand-written SQL for anything Drizzle can't
express — vector columns, HNSW indexes, generated `tsvector` columns).

### Accounts, sharing, sessions

| Table | Purpose |
|---|---|
| `users` | account record — `status` (`pending_approval`/`active`/`deactivated`), `role` (`member`/`admin`), password hash, TOTP secret |
| `sessions` | login sessions, SHA-256-hashed token |
| `mfaBackupCodes` | single-use MFA recovery codes |
| `emailTokens` | verify-email / password-reset single-use tokens |
| `teams`, `teamMemberships` | team entity + membership (`owner`/`member`) |
| `vaults` | note container, owner, `mergeable` flag (opt into the cross-vault merged graph) |
| `vaultShares` | direct-user or team grants on a vault, `read`/`edit`, unique on `(vaultId, granteeType, granteeId)` |
| `vaultGraphPreferences` | per-user opt-in for a vault in the merged graph view |
| `mcpConnections` | issued MCP bearer tokens, scoped `account`/`vault`/`repository`, hashed |
| `instanceState` | singleton row: setup-token lifecycle, instance-wide MFA requirement |
| `securityEvents` | append-only audit log (login failures, permission denials, admin actions, MFA events, export/backup access) |
| `notifications` | in-app notification rows |

### Notes

| Table | Purpose |
|---|---|
| `notes` | derived index of the on-disk OKF file — frontmatter (jsonb), body, generated `fts` (GIN-indexed), `embedding vector(384)` (HNSW-indexed); unique on `(vaultId, path)` **where `deleted_at IS NULL`** (a path can be reused once its old note is trashed) |
| `noteRevisions` | version history, `actorType` `user`/`mcp`/`collab` |
| `noteLinks` | extracted `[[wikilink]]` edges, fully replaced on every save |
| `exportLinks` | expiring/revocable vault export download links |

### Repositories (codebase mapping)

| Table | Purpose |
|---|---|
| `repositories` | ingestion method (`git`/`local_path`/`agent_push`), encrypted git credential/webhook secret, sync status/error, `mergeable` |
| `repositoryShares` | owner/viewer grants, same shape as `vaultShares` |
| `repositoryGraphPreferences` | per-user opt-in for a repo in the merged graph view |
| `repositoryFiles` | indexed file content — same `fts`/`embedding` pattern as `notes`; **hard-deleted** on resync, no trash |
| `repositoryFileImports` | extracted import edges, resolved against sibling files where possible |
| `repositoryFileSymbols` | per-file top-level declarations (function/class/interface/type), surfaced as a file "outline" — **not** emitted as a graph edge despite the schema comment calling them "contains" edges |
| `repositorySyncTokens` | bearer tokens for agent/CLI push ingestion, same lifecycle as an MCP token |

### Cross-cutting

| Table | Purpose |
|---|---|
| `semanticEdges` | polymorphic `(nodeAType, nodeAId, nodeBType, nodeBId)` — `note` or `code` on either side, no FK constraint (the id points at different tables depending on type, same posture as `vaultShares.granteeId`). Pairs canonically ordered so `(A,B)` and `(B,A)` never both exist. This is the mechanism that lets a note and a source file land as semantic neighbors — they share one 384-dimension embedding space by construction. |

**Design decisions worth remembering:**
- Polymorphic grantee/node columns (`vaultShares.granteeId`,
  `repositoryShares.granteeId`, `semanticEdges.node*Id`) are
  **intentionally** not FK-constrained — the target table depends on a
  sibling `*Type` column.
- Partial unique indexes (`WHERE deleted_at IS NULL`) implement
  "live-only uniqueness" so soft-deleted rows don't block reuse of a
  path/name.
- `notes.embedding` and `repositoryFiles.embedding` are the same
  384-dim vector space on purpose, not by coincidence — that's what
  makes note↔code semantic edges possible with no new mechanism beyond
  a shared table.

---

## 5. Subsystem walkthrough

### 5.1 Auth (`server/src/auth/`)

Session-cookie auth (not JWT) — a random token, SHA-256-hashed before
storage, resolved on every request via a Fastify `onRequest` hook.

- **Bootstrap** (`bootstrap.ts`): one-time `/setup` endpoint gated by an
  out-of-band token (`SETUP_TOKEN` env var or a generated/logged one);
  404s permanently once complete.
- **Signup → verify → approve**: `/signup` responds identically whether
  or not the email already exists (anti-enumeration), sends a 6-digit
  email code; `/verify-email` consumes it; an admin then approves the
  account before it can log in.
- **Login**: checks lockout (see below), password (Argon2id via
  `@node-rs/argon2`), account status, email verification, then MFA if
  enabled.
- **Lockout** (`lockout.ts`): in-memory counters, 10 failures / 15
  minutes, keyed separately by account and by IP. **In-process only —
  see §9.**
- **MFA** (`mfa.ts`, `mfa-routes.ts`): TOTP via `otpauth`, one-time
  backup codes, no device-trust exception (every login is challenged
  once enabled), can be instance-mandated by an admin
  (`instanceState.requireMfa`) — mandated users are locked out of every
  route except `/mfa`, `/logout`, `/me` until they set it up.
  - `docs/superpowers/specs/2026-07-15-mfa-design.md`
- **Password reset**: anti-enumeration response, kills all sessions on
  successful reset.
- **Admin routes** (`admin-routes.ts`): approve/promote/deactivate
  users, transfer vault ownership. Deactivation cascades — kills
  sessions, removes team memberships and direct vault shares, fires a
  live permission-change event, notifies the user.
- **Admin dashboard** (`admin-dashboard-routes.ts`): metadata-only by
  explicit design — stats, audit trail, force-revoke a share or MCP
  connection. No endpoint here can return note content.
  - `docs/superpowers/specs/2026-07-15-admin-oversight-dashboard-design.md`

### 5.2 Vaults & sharing (`server/src/vaults/`)

- **`permissions.ts`**: `resolveAccess()` is the single access-check
  function every other subsystem calls — owner → direct share → team
  share, highest permission wins, deactivated users always resolve to
  no access. Always live, never cached.
- **`routes.ts`**: vault CRUD, sharing (`read`/`edit`, upserted on
  re-share rather than duplicated), ownership transfer, per-user
  merged-graph opt-in. Insufficient access returns 404, not 403 — "no
  access" and "doesn't exist" are made indistinguishable on purpose.
- **`team-routes.ts`**: team CRUD, membership management. Adding/
  removing a member notifies both that user and every owner of a vault
  currently shared with the team.
- **`mcp-connection-routes.ts`**: issues/lists/revokes MCP bearer
  tokens scoped to `account`, a specific `vault`, or a specific
  `repository`. Resolution (`resolveMcpToken`) is fully live — a
  revoked, expired, or now-inactive-owner token never resolves
  regardless of when it was issued.

Every share/membership mutation calls `emitPermissionChange()` (see
§5.6) and writes a `securityEvents` row.

### 5.3 Notes (`server/src/notes/`)

- **`okf.ts`**: OKF parsing/serialization/validation. Path segments are
  restricted to a slug regex (`^[a-z0-9][a-z0-9-]*$`), which makes path
  traversal impossible by construction — this is the one validation
  function shared by every write path (REST, CRDT persistence, MCP).
- **`store.ts`**: the note write path. `createNote` → validate → insert
  row (unique-violation on live path collision) → atomic disk write
  (write to `.tmp`, then `rename`) → regenerate the type's `index.md` →
  sync `noteLinks` from extracted wikilinks → schedule an embedding
  (async, off the request path) → record a revision. Soft delete moves
  the file into `.trash/<noteId>.md`; hard purge (owner/admin only) is
  a genuine irreversible delete, for cases like an accidentally
  committed secret where "recoverable" is the wrong property.
- Every mutation is attributed (`Actor {type: 'user'|'mcp'|'collab',
  id?}`), which is what makes `noteRevisions` a real audit trail across
  the UI, MCP, and live-collaboration write paths.

### 5.4 Notifications (`server/src/notifications/`)

One function, `notify()`: writes an in-app row, then **best-effort**
sends an email (failures are swallowed, never block or fail the
request). Five trigger sites: vault shared/revoked, team membership
changed, note reverted, signup approved. No preferences/opt-out exists
— every trigger always fires both channels.
`docs/superpowers/specs/2026-07-15-notifications-activity-feed-design.md`

### 5.5 Graph (`server/src/graph/`)

`buildGraph(resources, filters)` is the single function behind both the
vault-scoped and merged-view graph routes, and the MCP `graph` tool —
one implementation, three callers. Nodes are the union of `notes` and
`repositoryFiles` rows. Three edge kinds:

- **extracted** — real links: note wikilinks (including the `repo:`
  form that cross-links a note directly to a file in a specific,
  already-authorized repository) and resolved code imports.
- **structural** — derived groupings: notes by `type`/`tag`, code by
  language (global) or by top-level directory (per-repository — "same
  folder" only means something within one repo). Groups larger than 50
  are **skipped and reported**, never silently truncated.
- **semantic** — pulled from `semanticEdges`, filtered to the live node
  set.

Community detection runs `graphology-communities-louvain` over the
fully assembled graph on every call. The merged cross-resource view
additionally requires the resource owner's `mergeable` flag and the
viewing user's own per-resource opt-in — three independent gates, all
re-resolved live.

### 5.6 Search & embeddings (`server/src/search/`)

- **`search.ts`**: `searchNotes()` — the single hybrid search function
  used by the UI routes and the MCP `search` tool. Runs four queries in
  parallel (note-keyword, note-semantic, code-keyword, code-semantic)
  and merges them with **Reciprocal Rank Fusion** (`k=60`), no score
  normalization to tune. Keyword hits use Postgres
  `websearch_to_tsquery` + `ts_rank` + `ts_headline` snippets; semantic
  hits use pgvector's `<=>` cosine-distance operator over HNSW indexes.
- **`embeddings.ts`**: an `Embedder` interface with two
  implementations — `LocalEmbedder` (real: Transformers.js/ONNX,
  `bge-small-en-v1.5`, 384 dimensions, mean-pooled, normalized) and
  `FakeEmbedder` (deterministic bag-of-words hash, used in dev/test so
  the suite never downloads a model or touches the network).
  `config.embeddings` picks between them — `'local'` by default when
  `NODE_ENV=production`, `'fake'` otherwise, overridable via
  `EMBEDDINGS`.
- **`embedding-queue.ts`**: an in-process serial queue —
  `scheduleEmbedding()` never blocks the caller (notes/store.ts calls
  it fire-and-forget on create/update/revert). A boot-time scan
  (`scheduleMissingEmbeddings`) catches up any note left with a null
  embedding. One bad note's embedding failure is logged and skipped,
  never stops the drain.
- **`semantic-edges.ts`**: `recomputeSemanticEdges()` — kNN against
  both notes and code, filtered to `similarity >= SEMANTIC_THRESHOLD`
  (default 0.75), capped to `SEMANTIC_K` (default 8) per node. Called
  from both the note embedding queue and the repository extraction
  queue — this is the shared mechanism, not two parallel ones.

### 5.7 Real-time collaboration (`server/src/sync/`)

- **`collab-server.ts`**: the Hocuspocus relay. Document name is
  `"<vaultId>/<path>"`. `onAuthenticate` requires live `edit` access.
  **`beforeHandleMessage` re-resolves access on every inbound Yjs
  message**, not just at connect time — dropping below `edit` mid-session
  drops the next message and closes the connection. `onStoreDocument`
  debounces (default 2s) persistence back through the same OKF write
  path used everywhere else; a write that fails validation is logged
  and the last good file state is kept, never corrupted.
- **`permission-events.ts`**: an in-process `EventEmitter` bus.
  Every share/team/deactivation mutation calls `emitPermissionChange()`;
  the collab server and the SSE viewer hub both subscribe and actively
  close any connection that no longer qualifies — this is what makes
  revocation instant instead of "eventually, on reconnect."
- **`viewers.ts` / `routes.ts`**: a separate SSE mechanism for
  **read-only** live viewing — these clients never join the Yjs
  document (no awareness, no cursor identity broadcast), by structural
  design rather than a permission mode.
- MCP-originated edits are written through the *same* live document
  when one is open (`mcp/crdt-write.ts`), so a human editing a note
  sees an AI's edit streaming in like any other collaborator, not as a
  silent external change.

### 5.8 MCP (`server/src/mcp/`)

- **Transport**: `POST /mcp` (note: unprefixed, not under `/api`),
  official SDK's `StreamableHTTPServerTransport`, **stateless** —
  `sessionIdGenerator: undefined`, a fresh `McpServer` + transport
  built per HTTP request. No cross-connection caching is possible by
  construction; auth and permissions are recomputed every call.
- **Auth**: bearer token → `resolveMcpToken()` (same live-resolution
  guarantee as everywhere else) → per-connection rate limit
  (`rate-limit.ts`, default 120/min, in-process — see §9).
- **Scoping** (`server.ts`): an `account`-scoped connection can address
  any resource the user can reach; a `vault`- or `repository`-scoped
  connection is **hard-pinned** — passing a different id throws, it's
  never silently narrowed or widened. Account-only tools
  (`list_vaults`, `list_repositories`, unscoped `search`) hard-reject
  non-account tokens.
- **Tools**: `list_vaults`, `browse_vault`, `read_note`, `create_note`,
  `edit_note`, `delete_note`, `search`, `graph`, `note_history`,
  `revert_note`, `list_repositories`, `browse_repository`,
  `read_file` (includes a symbol outline), `repository_status`. Every
  handler is wrapped so thrown errors become a structured `isError`
  result instead of an uncaught exception. `search` and `graph` call
  the exact same `searchNotes()`/`buildGraph()` functions the REST
  routes use — one implementation, not a parallel MCP-specific path.

### 5.9 Export & backup (`server/src/export/`)

- **Vault export**: zip with a manifest, requires `edit`-or-owner
  access ("a copy outlives later revocation" — read access isn't
  enough). Sessionless, time-boxed **export links**
  (`EXPORT_LINK_TTL_HOURS`, default 24h) for sharing outside the app.
- **Import** (`POST /api/import`): uploads a zip, creates a **new**
  vault with a **new** owner and new IDs, re-validates every note
  through the normal OKF write path, best-effort per note (an invalid
  note is skipped and reported, not fatal).
- **Instance backup** (`GET /api/admin/backup`, admin-only): a full
  dump of every account-layer table plus a copy of every live note
  file.
- **Restore** (`server/src/export/restore.ts` +
  `server/src/scripts/restore-backup.ts`): **CLI only**
  (`pnpm restore-backup <zip>`), deliberately **not** an HTTP endpoint —
  restoring over a live instance isn't a button. Hard-refuses to run
  against a non-empty instance, no override flag. Preserves the
  dump's original IDs — a true restore, not an import — account-layer
  tables restore inside one transaction, then notes are recreated
  per-file through `createNote`. Restored MCP connections are metadata
  only; raw tokens were never recoverable (only hashes were ever
  stored) and must be reissued.

### 5.10 Repository ingestion & codebase mapping (`server/src/repositories/`)

Repositories are a read-only sibling of vaults: same owner/share
pattern (simplified to `owner`/`viewer`, no edit tier — "nothing here
is ever written to"), same live permission resolution, same merged-
graph opt-in mechanism.

**Three ingestion methods, one convergence point** — every method ends
up calling `syncRepositoryFiles()` (`store.ts`), which diffs against
what's already indexed: unchanged content hashes are no-ops, changed/
new files upsert, anything no longer present is **hard-deleted** (git
is the history record, not Chapters).

1. **git** (`git-sync.ts`) — a fresh shallow clone (`--depth 1`) into a
   scratch temp dir on every sync, discarded after reading; no
   persistent working copy. Triggered by a webhook
   (`git-webhook-routes.ts`, HMAC-SHA256-verified,
   `POST /repositories/:id/webhook`, unprefixed) or a polling fallback
   (`scheduler.ts`) that only kicks in once the webhook signal goes
   stale — `shouldPoll()` is a pure function, unit-tested on its own.
2. **local_path** (`local-watch.ts`) — `chokidar`, debounced 300ms,
   real-time. The path must resolve under `LOCAL_REPOS_ROOT`, checked
   at repository-creation time.
3. **agent_push** (`push-routes.ts`) — `POST /repositories/sync`,
   bearer sync-token auth, the client sends its own file list directly
   — the closest analog to how a coding agent itself already works.

**Credential encryption** (`credentials.ts`): AES-256-GCM,
`CREDENTIALS_ENCRYPTION_KEY` (32-byte hex), used for both git
credentials and webhook secrets. Reversible by design (a stored
credential must be usable again on the next pull) — **there is no key
rotation mechanism**; rotating it invalidates every stored credential.

**Code extraction** (`extraction.ts`): `web-tree-sitter` (WASM), four
supported languages — TypeScript, JavaScript, Python, Go. Each
language's grammar is loaded from its own npm package's `.wasm` file;
parsers are cached and initialized once. Per language, a tree-sitter
query extracts import statements and top-level symbol declarations
(function/class/interface/type, per language's actual grammar).
Extraction is deferred until the *entire* sync batch has been
persisted (see §11 for why — this fixed a real ordering bug found via
live e2e testing, not unit tests). Imports resolve only against
sibling files already known within the same repository; unresolved
(non-relative) imports are stored but produce no graph edge. Symbol
rows (`repositoryFileSymbols`) are a per-file outline surfaced through
the MCP `read_file` tool — despite the schema comment calling them
"contains edges," they are **not** emitted as actual graph edges by
`buildGraph()`.

`docs/superpowers/specs/2026-07-18-repository-ingestion-design.md` and
`2026-07-18-code-graph-integration-design.md` are the full specs.

---

## 6. Security posture

- **Passwords**: Argon2id (`@node-rs/argon2` defaults).
- **Tokens** (sessions, email verification, password reset, MFA backup
  codes, MCP connections, repository sync tokens, export links):
  SHA-256-hashed at rest, raw value returned exactly once at creation.
- **Repository credentials / webhook secrets**: AES-256-GCM,
  reversible, no rotation.
- **Permission checks**: always live, never cached (see §1) — this is
  the load-bearing security property the whole audit trail and
  revocation-kick behavior depends on.
- **Anti-enumeration**: signup, login, and password-reset responses are
  identical whether or not an account exists.
- **Access-denial shape**: insufficient vault/repository access returns
  404, not 403, everywhere — "no access" and "doesn't exist" are
  indistinguishable to the caller.
- **Audit log**: `securityEvents` — login failures, lockouts, permission
  denials, admin actions, MFA setup/challenge, MCP auth failures, vault
  exports.
- **Security headers**: `@fastify/helmet`, registered unconditionally.
- **CORS**: off by default (same-origin only — correct for a
  reverse-proxied self-hosted app); opt in per-instance via
  `CORS_ORIGIN` (comma-separated allowlist).
- **Rate limiting**: global Fastify rate limit (1000/min) plus a
  stricter limit on abuse-sensitive auth routes, plus a separate
  per-connection MCP rate limit (120/min default).
- Full findings and the design changes they drove:
  `docs/superpowers/specs/2026-07-12-security-audit-findings.md`.

---

## 7. Testing

```
pnpm typecheck      # tsc --noEmit, both workspace packages
pnpm lint           # eslint . (root)
pnpm -C server test # vitest run — needs Postgres reachable at DATABASE_URL
```

- Vitest, one test file per subsystem under `server/test/`.
- Tests run against a **real** Postgres (`docker compose up -d db`),
  not a mock — the test DB is auto-created.
- The default embedder in tests is `FakeEmbedder` (deterministic,
  no network/model download) unless `NODE_ENV=production` is forced —
  see §11 for why that distinction matters and was once a real
  verification gap.
- Live/e2e verification (booting a real server against a real database
  and exercising it over real HTTP) is a standing project discipline,
  not optional — several real bugs in this codebase (an extraction
  ordering race, a `.gitignore` rule silently excluding a needed file,
  a Docker build OOM) were only ever caught this way, never by unit
  tests alone. See `handling-protocols.md`'s testing protocol.

CI (`.github/workflows/ci.yml`) runs all three steps against a
`pgvector/pgvector:pg17` service container on every PR and on push to
`dev`/`prod`. Green CI is a merge precondition (`github-workflow.md`).

---

## 8. Deployment

- **`Dockerfile`** (repo root): `node:24-slim` (Debian, not Alpine —
  `onnxruntime-node` and `sharp` need prebuilt glibc binaries), installs
  via `pnpm install --frozen-lockfile`, runs via `tsx` directly (no
  separate build step — this is the *only* execution path this app has
  ever used, dev and prod alike). Exposes `3000` and `3001`.
- **`docker-compose.yml`**: Postgres (`pgvector/pgvector:pg17`) for
  local dev/test. The app image itself isn't in this file yet — build
  and run it directly (`docker build . && docker run ...`) or add a
  service block if you want one-command full-stack startup.
- **`server/.env.example`**: every environment variable, documented,
  in one place — copy to `server/.env` (or set equivalently) before
  running. Notable ones: `DATABASE_URL`, `DATA_DIR`,
  `CREDENTIALS_ENCRYPTION_KEY` (required only once a private repo or
  webhook secret is configured — `openssl rand -hex 32`), `SETUP_TOKEN`,
  `SMTP_*` (optional — falls back to in-memory capture), `EMBEDDINGS`,
  `CORS_ORIGIN`.
- **Migrations**: `drizzle-kit generate` produces SQL under
  `server/drizzle/`; a few migrations were hand-edited afterward for
  things Drizzle can't express directly (pgvector extension + HNSW
  indexes, generated `tsvector` columns). Migrations run automatically
  on boot and are also run explicitly first thing by the
  `restore-backup` CLI script.
- **colima (macOS Docker runtime)**: needs **at least 6GB memory / 4
  CPU** (`colima start --cpu 4 --memory 6`). At the default 2GB,
  `onnxruntime-node`'s native postinstall step OOM-kills the `pnpm
  install` inside a Docker build (exit 137). This is a real, previously
  hit constraint, not theoretical.

---

## 9. Known limitation: single-process only (read before scaling)

Five subsystems hold state in the Node process's memory, not in
Postgres or any shared store. None of them are broken for the intended
single-instance deployment, but **all of them silently misbehave the
moment a second instance runs against the same database**:

| Subsystem | File | Failure mode with 2+ instances |
|---|---|---|
| Login lockout | `auth/lockout.ts` | each instance has its own counter — the effective threshold multiplies by instance count |
| Embedding queue | `search/embedding-queue.ts` | work scheduled on one instance never runs on another (no double-processing, but no load distribution either) |
| Extraction queue | `repositories/extraction-queue.ts` | same as above |
| Permission-change bus | `sync/permission-events.ts` | an instance that didn't receive the in-process event never kicks its own live connections — a revoked user could keep a session open on a *different* instance |
| MCP rate limiter | `mcp/rate-limit.ts` | a client can get up to N× the intended limit by landing requests across N instances behind a load balancer |
| Git polling scheduler | `repositories/scheduler.ts` | multiple instances independently poll/clone the same repos on their own schedules |

**Upgrade path, if this is ever actually needed**: Postgres
`LISTEN`/`NOTIFY` or Redis pub/sub for the permission-event bus; a
`jobs` table (or a real queue like BullMQ) with a claim/lock column for
the embedding/extraction queues and the polling scheduler; move the
lockout and rate-limit counters to Postgres or Redis with atomic
increment. **None of this is built** — this was a deliberate scope
decision (building distributed versions of all five with no current
deployment need would be premature scaling work), not an oversight.
Each site above carries its own `ponytail:` comment naming this same
upgrade path in the code.

---

## 10. Maintenance runbook

**Add a new sub-project or feature**: write its design spec first
(`docs/superpowers/specs/`), a lighter implementation plan
(`docs/superpowers/plans/`), then implement task by task, TDD, one PR
per unit of work, following `handling-protocols.md` and
`github-workflow.md`. Update `STATE.md` and this file (if the change is
structural) in the same PR.

**Add a migration**: change `server/src/db/schema.ts`, run
`pnpm -C server db:generate`, review the generated SQL, hand-edit if it
needs something Drizzle can't express (see §8), commit both the schema
change and the migration file together.

**Restore a backup**: `pnpm -C server restore-backup <path-to-zip>`
against a **fresh, empty** instance only — it hard-refuses otherwise,
by design. There is no HTTP restore path and no override flag.

**Rotate `CREDENTIALS_ENCRYPTION_KEY`**: there is no rotation
mechanism. Changing it makes every previously stored repository
credential/webhook secret undecryptable — re-enter them after
rotating.

**Update dependencies**: Dependabot runs weekly
(`.github/dependabot.yml`), npm and github-actions ecosystems. The npm
`dependencies` group only bundles **minor/patch** updates — major
version bumps arrive as individual PRs on purpose. This split exists
because a bundled major bump (typescript-eslint vs. a too-new
TypeScript major, in one real case) can break CI for the *entire*
batch, blocking safe updates alongside it; splitting means a broken
major PR can be closed or deferred without blocking everything else.
When a major-bump PR fails CI, check whether it's a real code
incompatibility (fix it) or an upstream tooling gap (close the PR,
wait for upstream, re-open manually later) — don't force-merge over
red CI.

**Add an MCP tool**: register it in `mcp/server.ts` via
`server.registerTool()` with a `zod` input schema, wrap the handler
logic so it reuses an existing live-permission-checked function
(`resolveAccess`/`resolveRepositoryAccess`) rather than inventing a new
check — every existing tool follows this pattern.

**Common failure modes seen in this project**:
- **Docker build OOM / exit 137** → colima needs ≥6GB memory (§8).
- **`.gitignore` silently excluding a needed file** → after any broad
  `git add -A`, run `git status --short` and, if something expected is
  missing, `git status --short --ignored` to check for an over-broad
  glob (e.g. `.env.*` also matching `.env.example`).
- **Native module compile failure** (e.g. `tree-sitter` proper, as
  opposed to `web-tree-sitter`) against a newer Node's V8 headers →
  prefer a WASM-based alternative over pinning Node to an older
  version.
- **A dependency imported directly but only resolving under `tsx`, not
  plain `node`** → check `require.resolve('<pkg>/package.json')` under
  plain `node`, not just under the app's normal launch command; a
  package that's only a transitive dependency of something else can
  resolve by accident via a package manager's hoisting behavior and
  break the moment that transitive relationship changes. (This bit
  `tree-sitter-javascript` once — see the PR titled "Declare
  tree-sitter-javascript as an explicit dependency.")

---

## 11. Notable implementation history

A few decisions and bugs worth knowing about because they explain *why*
the code looks the way it does, not just *what* it does:

- **Native `tree-sitter` → `web-tree-sitter`**: the native bindings
  failed to compile against a current Node's V8 headers (they target an
  older C++ standard than the toolchain provides). The WASM-based
  `web-tree-sitter` package uses the exact same npm grammar packages,
  which already ship prebuilt `.wasm` files — no native compilation
  involved, same extraction behavior.
- **Extraction ordering race**: originally, code extraction was
  scheduled per-file inside the repository sync loop, so one file's
  import resolution could run before a sibling file in the same sync
  batch had actually finished being persisted — a real race, found only
  by a live end-to-end smoke test, not by unit tests (the unit tests
  all happened to exercise files in a lucky order). Fixed by deferring
  every extraction schedule until the *whole* sync batch commits; a
  regression test with a deliberately dependent-before-dependency file
  order now guards it.
- **`semanticEdges` was originally note-only**: the note→code semantic
  edge feature's spec claimed "no new mechanism needed," but the table
  as it existed was a `note_a`/`note_b` FK pair. It was migrated to the
  current polymorphic `(nodeAType, nodeAId, nodeBType, nodeBId)` shape
  specifically to make cross-type edges representable — the spec's
  claim was wrong and was corrected in the implementation rather than
  worked around.
- **The production embedding path went unexercised for a long time**:
  `config.embeddings` only defaults to `'local'` (the real ONNX model)
  when `NODE_ENV=production`; every test and every earlier smoke test
  ran without that env var set, so the real embedding code had zero
  runtime coverage despite being core to the product's AI-navigability
  claim. Caught by a deliberate audit, not by any test failing — a
  reminder that "tests are green" and "the real path has actually run"
  are different claims, and the second one sometimes has to be checked
  by hand.
- **`tree-sitter-javascript` phantom dependency**: it was imported
  directly in `extraction.ts` but never declared in
  `server/package.json` — it only resolved because `tsx` (this app's
  only launch method) exposes pnpm's hoisted `node_modules` via
  `NODE_PATH`, and pnpm happened to hoist it as a transitive dependency
  of `tree-sitter-typescript`. A plain `node` invocation, or any
  lockfile change that altered that transitive relationship, could have
  silently broken JavaScript code extraction — and there was no test
  that would have caught it (TS/Python/Go each had a case,
  JavaScript didn't). Fixed by declaring it explicitly and adding the
  missing test case.

---

## 12. Where to go from here

- **What's built and what's next**: `docs/agents/STATE.md`.
- **Full design intent**: `docs/superpowers/specs/` — one file per
  sub-project, plus the security audit, tech-stack decision, and
  cross-cutting specs (notifications, admin dashboard, MFA).
- **How work actually gets done**: `docs/agents/handling-protocols.md`
  (testing/context/resume discipline) and
  `docs/agents/github-workflow.md` (branches, PRs, promotion to `prod`).
- **Hard rules that don't change per-task**:
  `docs/agents/implementation.md` (performance budgets, phase
  discipline, the single-process caveat in more implementation-facing
  language than §9 above).
