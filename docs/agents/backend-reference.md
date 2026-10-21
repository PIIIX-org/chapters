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
- **Collaboration relay** (Hocuspocus/Yjs) — **no port of its own**. It rides
  the HTTP server above, taking the `upgrade` event on `/collab`. Started right
  after the HTTP server
  (`server/src/index.ts`).

```
                 ┌─────────────────────────────────────┐
                 │            one Node process          │
  HTTP :3000 ───▶│  Fastify API (REST + MCP)             │
                 │  Hocuspocus relay on /collab (Yjs CRDT) │
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
│   │   ├── monitoring/             # in-process request/job metrics + error reports, GET /api/admin/monitoring
│   │   ├── lifecycle.ts            # process identity for /health; DATA_DIR/lifecycle.json shutdown marker
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
│   │   └── scripts/                # CLI entry points (reindex, restore-backup, check-notes, migrate-store)
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
| `userVaultPreferences` | per-user vault organization preferences: storage mode ('online'/'local'), folders, colors, and favorites |
| `mcpConnections` | issued MCP bearer tokens, scoped `account`/`vault`/`repository`, hashed; `access` (`read`/`write`/`admin`), `allowedTools` (null = all), `expiresAt` (null = never), all set at mint time |
| `instanceState` | singleton row: setup-token lifecycle, instance-wide MFA requirement |
| `securityEvents` | append-only audit log (login failures, permission denials, admin actions, MFA events, export/backup access) |
| `notifications` | in-app notification rows |

### Notes

| Table | Purpose |
|---|---|
| `notes` | derived index of the on-disk OKF file — frontmatter (jsonb), body, generated `fts` (GIN-indexed), `embedding vector(384)` (HNSW-indexed); unique on `(vaultId, path)` **where `deleted_at IS NULL`** (a path can be reused once its old note is trashed) |
| `noteRevisions` | version history, `actorType` `user`/`mcp`/`collab`; `action` `create`/`update`, the events `delete`/`restore`/`rename`/`revert`, `restore_point` for the state before an MCP connection's first write in a session (#482), `quarantine` for a write kept out of the note (#492, not the note's content), or `proposal` for an `edit_note` with a stale `base_rev` that overlapped changes made since (#475, not the note's content). Events (#479) are always a new row (never deduped as a repeat) with the note's state; neither events, restore points, quarantine nor proposal rows are ever the row a later write is compared with (`recordRevision` compares with the latest `create`/`update`). Migration 0023 adds `from_path`/`to_path` (a `rename`) and `source_revision_id` (a `revert`: the revision brought back; a `proposal`: its base revision; no FK, a purged source leaves it dangling). Revert never relabels an earlier row. Migration 0024 (#825, #811) adds `ord` (`bigserial`, index `note_revisions_note_ord (note_id, ord)`): the order revisions were recorded in. Every list of a note's revisions and every "latest revision" lookup orders by `ord`, never by `created_at`, which comes from the database clock and can tie or step back. A restore point takes its `ord` (and its time) when it reads the state, before the write it precedes; a quarantine that is continued takes a new one with its new time. Rows from before 0024 got `ord` in `(created_at, id)` order |
| `noteLinks` | extracted `[[wikilink]]` edges, fully replaced on every save |
| `exportLinks` | expiring/revocable vault export download links |

**ADR-003 store schema (migration 0021, S1: present, not used yet).** The
schema for the single authoritative store (vault note
`decision/adr-003-authoritative-store` §4) is in place; no code reads or
writes it until S2a/S2b, so behaviour is unchanged. It is additive: code
from before 0021 runs on it with no SQL (no NOT NULL column without a
lasting default on a table old code writes, nothing dropped or renamed).

| Object | Purpose |
|---|---|
| `notes.seq` | `bigint NOT NULL DEFAULT 1`; the `notes_bump_seq` BEFORE UPDATE trigger adds 1 whenever `body`, `frontmatter`, `path` or `deleted_at` changes, so old code bumps it too. The note's `rev` on every MCP read and write (#477, S4) |
| `notes.frontmatter_src` | `json` copy of the frontmatter in its original key order (jsonb reorders keys); for rendering files and answering reads |
| `note_revisions.seq` / `idempotency_key` / `actor_detail` | one revision per `seq` (partial unique `note_revisions_note_seq`), actor detail (#403). `idempotency_key` stays unused: #477's keys need the call's arguments and its whole answer, also for writes that record no revision, so they live in `write_idempotency` |
| `write_idempotency` (migration 0025) | the first answer of an MCP write sent with `idempotency_key` (#477, `mcp/write-result.ts` `runWrite`): PK (`connection_id`, `key`), `tool`, `args_hash` (sha256 of the tool, vault and canonical arguments), `note_id` (FK to `notes`, cascade: purging the note deletes its keys and the note text their answers hold), `result` jsonb, `created_at` (indexed). A write that commits inserts its row **inside its own store transaction** (`WriteOptions.recordKey`, called with the committed row by `createNote`, `writeNote`, the rename move, `softDeleteNote`, `restoreNote`), so a crash after COMMIT and before the answer still leaves the key and the retry replays (ADR-003 §4, §10); its recorded answer has `indexed: false`. Answers that commit nothing (`conflicted`) are inserted after the call. A repeat with the same hash answers `result` + `replayed: true`; another hash is refused. Every keyed call first deletes rows older than 24 h. Calls with one key run one at a time (in-process key lock). Rows also go with their connection (FK cascade) |
| `note_crdt` | Yjs snapshot per note id (replaced `.crdt/<path>.bin` in S2b): `snapshot_through`, `folded_through`, `folded_seq`, `fold_error` |
| `note_updates` | Yjs update log tail (collab journal), `bigserial` id = commit order per note, actor columns, `rejected_at`/`reject_reason` |
| `note_projections` | per note and projection (`file`/`dir_index`/`embedding`): `target_seq`, `applied_seq`, `index_version`, lease and error columns; `note_projections_pending` indexes the work queue |
| `projected_files` | per `(vault, path)`: owner (`note`/`trash`/`dir_index`), `applied_hash` of the bytes last written, `applied_seq` |
| `jobs` | outbox for cross-note work (rename refactor, file removal, #494 extraction) with `idempotency_key`, lease and attempts |
| `instance_state.store_migrated_at` / `collab_migrated_at` | backfill markers for S2a and S2b |

`schema.ts` declares the five new tables. The new columns on `notes`,
`note_revisions` and `instance_state` stay out of the Drizzle models until
S2a: REST and MCP return note and revision rows whole, so declaring them
would add fields to responses. The S1 dry run is
`pnpm -C server migrate-store --dry-run` (§10).

**S2b: the relay's state is `note_crdt` + `note_updates`**
(`sync/note-crdt.ts`). A note's document is `snapshot ⊕` its non-rejected
updates with `id > snapshot_through`. Every store write that changes a note
with CRDT state appends its change as one Yjs update in the same
transaction (`folded_seq` follows `notes.seq`); the relay's store appends
the editors' delta and folds it; unload and `purge_revision` compact
(snapshot re-encoded, compacted updates deleted). A note with no state is
seeded on first load deterministically (`seedClientId`: the first 4 bytes of
`sha256("elara-seed/1\0" ‖ noteId ‖ "\0" ‖ body ‖ "\0" ‖ canonicalJSON(frontmatter))`;
later changes use the process's own client id), so two seeds of the same input merge. A load,
store or write that finds `notes.seq > folded_seq` (the row changed outside
the store) first merges that change into the state three-way against the
revision at `folded_seq` (`mergeTextKeepingTheirs`: by lines, then per
character inside lines both sides changed, so edits to different words of
one line both stay; where characters overlap the typing stays) and
never rebuilds the text (#488). There are no `.crdt` bins any more. Each
open document caches the stored state it holds (`note-crdt.ts`
`storedStates`: the state vector and the last update id, set at load and
after every write that had the document in hand, dropped on `fold_error`
and with the document). While the last non-rejected update id, a null
`fold_error` and `folded_seq = notes.seq` still match it, a store or
server write reads only the bookkeeping and works on the document's own
clone, its typing being the delta over the cached vector, instead of
materialising `snapshot ⊕ tail`; any other writer's append makes the next
write materialise and refresh the cache.

**S2b backfill and boot** (`sync/collab-backfill.ts`, `bootCollab` in
`index.ts` before `listen`, after the S2a backfill): while
`instance_state.collab_migrated_at` is null, each live note's
`.crdt/<path>.bin` is attached when its text equals the row, the file or a
revision (with a diff to the row's text on top) and otherwise moved to
`vaults/<id>/.migration/<date>/bins/` (`setAside[].reason`: `unknown-text`,
`undecodable`); one transaction per note, so a rerun resumes. A note whose
backfill failed is refused by the relay with `note-not-migrated` and never
seeded until a restart attaches its bin (`setCollabNotMigrated`, store-tx.ts);
otherwise a seed would make the rerun skip it and retire its bin. The
finish (no failure, no note waiting for S2a) sets the marker, renames each
vault's `.crdt/` to `.crdt.pre-adr-003/` (kept for a code-only rollback) and
writes `DATA_DIR/collab-migration-report-<time>.json`. Afterwards (roll-forward
after a code-only rollback), a `.crdt/` bin left by older code is merged into
`note_crdt` as a Yjs update only when it shares history with the note's state
(a Yjs client in common other than the process's `SERVER_CLIENT_ID`: the
bin the old relay saved from the exported state); a bin older code seeded
afresh from the file shares none and is set aside (`unrelated`), since merging
it would double the note. `.crdt/` then moves to `.crdt.rollback-<time>/`, and
what older code changed in the row reaches the state through the rebase.
Every boot then runs ADR §7 steps 4-5: merge rows changed outside the store
(`notes.seq > folded_seq`), then fold every pending tail, each note in its
own transaction (a failure sets `fold_error` to `boot fold failed: …`,
records a failed `collab-store` job, and boot goes on). A stored update that
does not apply is marked `rejected_at` and named in `fold_error`, which the
fold of that transaction keeps; the next fold clears it.

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
Ending a session (logout, password change for the other devices,
password reset, deactivation) deletes its row and announces its hash
(`sessionHashes` on the permission bus, `sessions.ts`); every live
collab socket and live view it opened closes at once (#498, §5.7).

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
  users, transfer vault ownership. Deactivation cascades in one
  transaction — kills sessions, removes team memberships and direct
  vault shares, revokes every MCP connection of the user (one
  `mcp_connection_revoked` audit event each, #646) — then fires a live
  permission-change event and notifies the user. Reactivation restores
  the account only: revoked tokens stay revoked (a connection a pre-#646
  deactivation left live is revoked then), and the user mints new ones.
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
  `repository`. `POST /mcp-connections` also takes the token's
  capabilities (#548, #549), which no route changes later: `access`
  (`read` | `write` | `admin`; default `admin` for an account token,
  `write` for a pinned one). A pinned token is capped at the minting
  user's permission on the pin (#649): `admin` needs ownership (403
  `admin access on a <scope>-pinned connection requires owning the
  <scope>`), `write` needs an edit share on a vault (a read-only vault
  share, direct or through a team, gets 403 `write access on a
  vault-pinned connection requires edit permission on the vault; you
  have read permission, so mint a read token`); a repository share
  allows `write`. An omitted level takes the pin default lowered to the
  cap, so a read-only member's token is `read`.
  `allowedTools` (names checked against `listMcpTools()`, 400 for an
  unknown one) and `expiresAt` (ISO time, must be in the future).
  The Settings and vault forms always send a level. The vault form
  offers only the levels the route grants (`admin` to the owner, up to
  `write` to an editor, `read` alone to a read-only member) and starts
  at `write`, or at `read` for a read-only member; its allow-list picker
  leaves out tools whose `pinPermission` is above the user's permission.
  `GET /mcp-connections/tools` returns `listMcpTools()` (name, scope,
  capability, pinPermission) for the allow-list picker. Migration 0019 set
  existing account tokens to `admin` and left existing pinned tokens at
  `write`, whoever minted them; a restore of an older dump applies the
  same rule. Such a token held by a read-only member keeps `write` in
  the database, but `tools/list` filters by the live permission (§5.8),
  and every call is refused by the handler's own permission check, so no
  data migration is needed. Migration
  0020 dropped the column default, so every insert names its level.
  Resolution (`resolveMcpToken`) is fully live — a revoked, expired, or
  now-inactive-owner token never resolves regardless of when it was
  issued (HTTP 401 `invalid, revoked or expired MCP token`).

Every share/membership mutation calls `emitPermissionChange()` (see
§5.6) and writes a `securityEvents` row.

### 5.3 Notes (`server/src/notes/`)

- **`okf.ts`**: OKF parsing/serialization/validation. Path segments are
  restricted to a slug regex (`^[a-z0-9][a-z0-9-]*$`), which makes path
  traversal impossible by construction — this is the one validation
  function shared by every write path (REST, CRDT persistence, MCP).
  `validateNote` also requires frontmatter `type` to equal the path's
  first segment.
- **Frontmatter fence** (#400, `parseNote`): the frontmatter runs from an
  opening `---` line to the first line that is exactly `---` (trailing
  spaces/tabs allowed); LF and CRLF files both parse, and the body is
  returned verbatim after the closing fence's line break. A `---` inside
  a value (`title: alpha---beta`, a block-scalar line, a list item) or in
  the body is content, not a fence. The old regex ended the frontmatter
  at the first `---` anywhere, so such a value corrupted the note on its
  next read.
- **Round-trip check** (#400, `assertRoundTrips`, run by `validateNote`
  before the row or file is written): the note is serialized and parsed
  back; if that fails, or the frontmatter (deep-equal) or body (exact)
  differs, the write is refused with an `OkfValidationError`
  (`note cannot be stored: ...`) — HTTP 400 over REST, an `isError`
  result over MCP. The file is the canonical copy, so a note its own file
  could not reproduce must never be stored.
- **`store.ts`**: the note write path. `createNote` → validate → insert
  row (unique-violation on live path collision) → atomic disk write
  (`atomic-write.ts`: write to a temp file named per call —
  `<file>.<pid>.<random>.tmp` — then `rename`) → regenerate the ancestor
  directories' progressive `index.md` → sync `noteLinks` from extracted
  wikilinks → schedule an embedding (async, off the request path) →
  record a revision. Soft delete moves the file into
  `.trash/<noteId>.md`; hard purge (owner/admin only) is a genuine
  irreversible delete, for cases like an accidentally committed secret
  where "recoverable" is the wrong property.
- **Concurrent writes to one note** (#401): writers of one note run one
  at a time, in call order, through an in-process per-key lock
  (`key-lock.ts`, `withKeyLock`). `updateNote` holds `note:<vault>/<path>`
  for its whole row → file → links → revision sequence;
  `writeThroughCollab` holds `collab:<vault>/<path>` across the document
  edit, the relay's store of it and the attributed store write;
  `saveCrdtState` holds `crdt:<vault>/<path>`. The keys are distinct
  because the lock is not reentrant and those sections nest. A shared
  `<file>.tmp` used to let two writes truncate and rename away each
  other's temp file (raw `ENOENT` naming server paths) and leave the row
  and the file on different writes. The MCP tool wrapper returns only the
  code of a Node system error (`internal storage error (ENOENT)`); the
  full error goes to the server log. The lock orders writes; it does not
  merge them: a whole `body` write replaces the body, so two agents that
  each read a note and write it back with a line appended still keep only
  the later one (an `append` op resolves against the live text and keeps
  both, #408).
- **Rename, delete, restore, purge and create take the note lock too**
  (#484): `createNote`, `softDeleteNote`, `restoreNote` and `purgeNote`
  hold `note:<vault>/<path>` (restore and purge read the trashed row's
  path, lock it, then read the row again); `renameNote` holds the keys of
  the old and the new path (`withKeyLocks`, sorted) across the target
  check, the file and CRDT move, the row update, the index regeneration
  and its own links. An edit queued behind a rename or a delete then finds
  no note at the old path (`note not found`) instead of writing there, and
  of two writers making one path live (two renames, a rename and a create
  or a restore) the second gets `a note already exists`. Before, a rename
  copied a stale body over an acknowledged edit, an edit's file landed at
  the path the note had left, the losing rename's rollback unlinked the
  winner's file, and a restore could report success on a note a purge
  removed. Links in other notes are rewritten after the rename's locks are
  released, each through `updateFn` (`writeThroughCollab`) under that
  note's own lock: no code holding a `note:` lock waits for the relay's
  store hook (ADR-003 §5.1), and two renames rewriting each other's
  referrers would otherwise wait on each other. Lock order: `note:` keys
  (sorted when more than one), then `index:`. The keys are paths, not note
  ids (ADR-003 S2a moves to id keys): an editor tab left open at the old
  path after a rename still stores to a path with no note, as before.
- **Renames of notes that link to each other** (#803): each referrer is
  looked up again by note id when its links are rewritten
  (`relinkReferrer`): another rename may have moved it, and before, it was
  skipped, so two notes linking each other and renamed at once both kept
  the old links. The rewrite goes to `updateFn` as a function of the body
  (`BodyEdit`), applied under the referrer's lock to the stored body, or
  through the relay to the live document's text, so two renames rewriting
  one note both keep their link. The renamed note's path is read by id
  too, and again under that path's lock after the write: a rename of the
  note that looked for referrers before the new link was stored missed it,
  so a note that has moved gets another round (at most 5, then
  `[rename] … the notes kept moving` is logged). `syncLinks` replaces a
  note's link rows in one transaction, so a rename never sees a referrer
  with no links mid-write.
- **Edits merge frontmatter per key** (#438): `edit_note` and REST
  `PUT /api/vaults/:id/notes/*` take `frontmatter`, `body`, `replace`
  and `removeKeys`; `requestedEdit()` (`sync/crdt-write.ts`) turns them
  into a `NoteEdit` and refuses contradictions (`replace: true` without
  `frontmatter`, a key both set and removed: `NoteEditError`, HTTP 400).
  `writeThroughCollab` computes the next map from the live document's
  frontmatter (keys a person set but the relay has not stored yet are
  kept), or from the row without the relay: shallow per top-level key,
  `null` is a value, then `removeKeys`, `type` reset to the note's type.
  The result is validated with `validateNote` inside the document
  transaction before anything changes, so a refused edit reaches neither
  the store nor people with the note open; the document gets a per-key
  diff and `updateNote` the whole map. If a merge fails only because of
  a key already in the live document (a value a person typed that the
  relay refused to store), the error names that key and suggests
  `removeKeys` or `replace: true`. Internal full-state writers (revert,
  rename, the relay's own store) keep `frontmatterMode: 'replace'`, the
  default. The `sync_local_docs_to_vault` prompt tells the agent to
  update an existing note with `replace: true`, so the vault mirrors the
  file.
- **Edits are minimal diffs; `edit_note` takes ops** (#408):
  `writeThroughCollab` never deletes and re-inserts the whole Y.Text.
  `applyTextDiff` (`sync/text-diff.ts`) turns the live text into the new
  body with a minimal character diff (Myers O(ND) with the linear-space
  middle snake, over code points so no surrogate pair is split) inside
  the one document transaction; past `DIFF_TIME_LIMIT_MS` (100 ms) it is
  redone per line and refined per character inside each changed run as
  far as a second limit allows (ADR-003 §5.2 step 5); a run still left
  pairs its old and new lines in order and changes each pair only between
  its common start and end (linear), so a rewrite of every line of a
  large note (a `- ` before each) keeps every line's unchanged characters
  rather than replacing the run. Pairing is in order: when such a run also
  adds or removes lines partway through, the lines after that point are
  paired with their neighbours and keep less. Untouched
  characters keep their Yjs identity, so a person's caret stays on its
  text, their Ctrl+Z (a `Y.UndoManager` that tracks only their own edits,
  never the relay's updates) still finds what they typed (#483), and
  typing that reaches the relay after the write merges where it was
  typed. In each change the new text is inserted before the old is
  deleted, so a caret at the end of a replaced span lands after the new
  text and typing in flight joins after it. It used to delete the whole
  body and insert the new one: every open caret mapped to position 0,
  the person's undo had nothing left, and late typing landed at the
  start of the note. Every body writer (edit_note, REST PUT, revert,
  rename's link rewrites) gets this. An agent's edit is not undoable
  from the editor; note history reverts it. The relay's
  `onLoadDocument` still replaces the whole body when the note's file
  changed outside it.
  `edit_note` also takes `ops[]` (strict per-op schemas in
  `mcp/server.ts`; semantics in `sync/edit-ops.ts`): `replace_text`
  (`expectedCount`, default 1), `insert_before`/`insert_after` (unique
  `anchor`), `replace_section` (ATX heading outside code fences, by line
  or text, up to the next heading of the same or a higher level),
  `append`/`prepend` (whole lines), `delete_block` (unique `find`), and
  `frontmatter_set`/`frontmatter_add`/`frontmatter_remove`, which apply
  after #438's merge in `nextFrontmatter`. Overlapping matches count as
  ambiguous (`aa` occurs twice in `aaa`), a `find`/`anchor` holding half
  a surrogate pair is refused, and an error's `ops[i]` is the index in
  the whole `ops` array. Each op's result length is checked against the
  size cap (`assertLengthFits`, UTF-16 length being a lower bound on UTF-8
  bytes) before the result is built, so a large `replace` repeated many
  times is a `NoteTooLargeError`, not a string of hundreds of megabytes
  or a `RangeError`. Body ops resolve against the
  live text: once when the connection opens, for the size cap (#491) and
  the quarantine (#492), which run before the document is touched, and
  again inside the transaction, where the cap is re-checked on the exact
  result. An op that cannot be resolved throws `NoteEditError` (400) and
  nothing changes; `ops` with `body` is refused in `requestedEdit`.
  Without the relay, ops apply to the stored body. REST PUT keeps
  `body`/`frontmatter` and gets the minimal diff, not `ops`: the route
  builds the edit from its named fields only and refuses a body holding
  `ops` with 400 (its JSON schema does not validate them; edit_note's zod
  schema does). Every whole-markdown write (edit_note and REST PUT `body`,
  revert, a rename's referrer rewrite) goes through `writeThroughCollab`,
  so it reaches the live document as this diff from its text, never as
  delete-all/insert-all (#476). Without `base_rev`, a whole `body` still
  removes text typed after the agent's `read_note`; `read_note` itself
  serves the live document (#474, below).
- **Reads serve the live document; `rev` is `seq`** (#474, #477, ADR-003
  S4): `readLiveNote` (MCP `read_note` and `export_note`, REST GET of a
  note) folds first when the relay has the note's document loaded: under
  the note's key lock, one store transaction stores the document's state
  as a revision of its editors (`foldLive`, the same S2a fold a write
  makes first; one revision per fold, ADR Q8; nothing when it equals the
  row), then the row is served. A state the relay would refuse to store
  is not folded: the read serves the row with `fold_error`. A note with
  no loaded document is read without a lock. `readNote` stays the
  lock-free row read for callers that already hold the note's lock (the
  relay's load hook; key-lock is not reentrant) or that serve no agent.
  Reads and writes return `rev` = `notes.seq` (rows from the store carry
  `seq`: `WrittenNote`), so the text read is exactly the revision at
  `rev`. `edit_note` `base_rev` takes that integer (the revision with
  `seq` = it) or a revision id (the `rev` before S4 and `note_history`
  ids, #822): `getBaseRevision`, never a `quarantine` or `proposal` row;
  anything else is refused and nothing changes.
- **Write results** (#477, `mcp/write-result.ts`): every MCP note write
  answers its row (without `seq`) plus `rev`, `status`
  (`applied`/`merged`/`conflicted`, or `retry` when `StoreBusyError`
  refused it: nothing written, `rev` null), `diff_stats` (`diffLines`
  hunks from `WriteOutcome.before`, the state writeNote met, to the
  result; frontmatter keys whose values differ; null for rename, delete
  and restore), `concurrent_changes` (the `base_rev` report) and
  `indexed` (`noteIndexed`: the `file` and `dir_index` projections
  applied at `seq` and the `embed_note:<id>:<seq>` job done). `dry_run`
  (create, edit, append, upsert, revert) runs `compute` and returns before
  the transaction (`WriteOptions.dryRun`; `previewCreate` for a create):
  no restore point, and `propose`/the quarantine screen throw without
  recording (`proposalId: null`, `NoteWriteWouldQuarantineError`).
  `idempotency_key`: `write_idempotency` (above). A read whose fold
  the store refuses (StoreBusyError) fails as `NoteReadBusyError`, with a
  read's wording.
- **Stale base: three-way merge or proposal** (#475): with `base_rev`,
  `writeThroughCollab` gets `NoteEdit.base` and rebases the edit
  onto the live document inside the same transaction
  (`sync/three-way-merge.ts`): `body` per whole line (`diffLines` in
  `text-diff.ts`; base → live and base → agent hunks overlap when their
  base lines intersect, when an insertion falls strictly inside the other
  side's lines, or when both insert at one point; adjacent lines merge;
  overlapping hunks with the same result merge as one), `frontmatter` and
  `removeKeys` per key on the map they make from the base's (a key the
  agent left as the base had it keeps the live value; a key both changed
  to different values conflicts); `ops` still resolve against the live
  text and map. The size cap is checked on the agent's raw body, but the
  write quarantine (#492) only on the rebased body: compared with the
  stored body, a body made from an older, longer state would be a false
  growth finding after a person shortened the note. Without the relay,
  and when the note's file is damaged so no document loads (#384/#391's
  full-edit repair), the edit is rebased onto the stored row instead,
  with the same proposal, screen and report. A clean merge goes
  through the usual checks and
  `applyTextDiff` live → merged, so only the agent's lines change, and
  reports `status` `applied` (nothing changed since the base) or
  `merged` with `concurrent_changes` (`lines` `{line, removed, added}`
  numbered in the live body just before the edit, `frontmatterKeys`). An
  overlap, found before the transaction or inside it, writes nothing:
  `recordProposal` keeps the agent's version (its `frontmatter`,
  `removeKeys` and frontmatter ops applied to the base's map; its `body`,
  or its body ops applied to the live text, or the base's body) as a
  `proposal` revision whose `source_revision_id` (#479's column, carried
  by backups and the vault export/import) is the base; an identical retry
  reuses the actor's latest one, and `edit_note` returns `status:
  conflicted`, `proposalId` and `conflicts` (same shape) as a normal
  result. `note_history`, `get_revision` and the REST history list show
  it as `sourceRevisionId`; the History tab labels proposals "Proposed by
  <connection name>".
- **Atomic append and upsert** (#478): MCP `append_note` is the `append`
  op and `upsert_note` a whole-`body` edit, both an ordinary
  `withRestorePoint` + `writeThroughCollab` edit, which applies them to
  the live text under the note's `collab:<vault>/<path>` lock. With
  `createIfMissing` (always for `upsert_note`) the call first runs
  `createNoteIfMissing` (`notes/store.ts`): `createNote` when no live note
  is at the path, else null. Path uniqueness is the unique index's
  (ADR-003 §5.1): when another caller, `create_note` or `restore_note`
  creates the note between the check and the insert, the insert's 23505
  (`NoteExistsError`, unexported, the same "already exists" message) also
  answers null. So concurrent calls on a missing note create it once,
  and every other call edits it like any existing note, restore point
  included. Agents used to append by `read_note` + `edit_note` with the
  whole body, which lost 50–92% of concurrent appends in the lab
  (`concurrency`, `append-same`). Both tools merge `frontmatter` per key
  into an existing note (on create it is the note's frontmatter), run the
  size cap, the quarantine unless `allowGrowth`, the restore point (#482)
  and the presence row (#481) as `edit_note` does, and return the row
  plus `created`. The call that creates the note records no restore
  point (there was no earlier state) and, like `create_note`, is never
  quarantined. A note deleted between a call's create check and its edit
  answers `note not found`.
- **Revision dedupe** (#480, `recordRevision`): a write that repeats the
  latest revision records nothing. Frontmatter is compared as jsonb
  stores it: deep equality on its JSON form, so object key order (nested
  too), `undefined` members and Date vs ISO string never count; array
  order and every value do. It used to compare `JSON.stringify` output.
  A repeat is the same state from the same actor (kind and id), or from
  the relay (`collab`), whose store of a recorded state changes nothing.
  An attributed write (`mcp`, `user`) of the state the relay just stored
  is recorded, so an edit through the relay leaves the relay's `collab`
  revision and the attributed one; the `collab` row is never
  re-attributed, since it may bundle a person's typing (#403). Only
  content writes (`create`, `update`) are deduped, against the newest
  content revision: `quarantine`, `proposal` (#475), `restore_point`
  (#482) and the events `delete`/`restore`/`rename`/`revert` (#479) are
  never the baseline, and an event (`recordEvent`) is always recorded.
- **Progressive indexes** (`regenProgressiveIndices`): run on create,
  rename, delete, restore, and on updates whose frontmatter really
  changed (`isDeepStrictEqual`, so key order alone never counts: `jsonb`
  and the collab document order keys differently). A directory with a
  live `<dir>/index` **note** is skipped entirely: that file is the
  user's note, and the generated table must never overwrite or unlink
  it (#384, fixed 2026-10-12). Each call holds `index:<vault>/<dir>` for
  every directory it regenerates (`withKeyLocks`, taken in sorted key
  order) and reads the note list inside the locks, so concurrent writers
  into one folder write its `index.md` in turn and the last write lists
  every note committed before it; an older snapshot written last used to
  leave live notes out (#779). Lock order is `note:` before `index:`
  (every note writer regenerates inside its note locks; nothing takes a `note:`
  lock while holding an `index:` lock).
- **`integrity.ts`** / `pnpm check-notes`: parses every live note's file
  from disk the way `readNote` does and compares it with the note's row.
  Each problem has a kind: `missing-file`, `unparseable`,
  `frontmatter-mismatch` (deep equality, key order ignored; the detail
  lists the differing keys) or `body-mismatch` (exact string; the detail
  gives the first differing offset and both lengths). Exit 1 if any. An
  unparseable note cannot be opened until its file is rewritten; a
  mismatched note reads as the file while search, graph and history use
  the row. CI runs it after the test suite against the suite's database
  and `DATA_DIR` (#578), so a test that leaves a note in any of these
  states fails CI. Tests that damage a note on purpose restore its file
  before they end, and tests that insert note rows without files delete
  their fixture vaults. One exception: the MCP storage-failure test pins
  the known row-ahead-of-file bug (#486, #489) with an assertion and then
  soft-deletes that note so the gate skips it.
- **Damaged files** (`sync/crdt-write.ts`, #391): every write loads the
  collab document from the note's file first, so a file that does not
  parse used to block edit and revert too. When the load fails on a
  damaged file, a full replacement (frontmatter **and** body, which a
  revert always is) is written straight to the store and so repairs the
  file; a partial edit is refused with `NoteFileDamagedError` (409),
  since it would have to merge with content that cannot be read.
- **Body size cap** (#491, `size-cap.ts`): one cap on every write path,
  `ELARA_NOTE_MAX_BYTES` (`config.noteMaxBytes`, default 1 MiB =
  1048576), measured as the **UTF-8 bytes of the body** (frontmatter is
  not counted). `assertBodyFits` runs in `createNote` and `updateNote`
  (REST, MCP, import, the relay's store) and in `writeThroughCollab`
  before the live document is edited, so a refused write never reaches
  editors. A write is refused (`NoteTooLargeError`, an
  `OkfValidationError`) when the body is over the cap **and** larger than
  the body it replaces, so a note stored before the cap can still shrink
  and take frontmatter edits. REST answers 413 `{ error: "note body is N
  bytes (UTF-8); the limit is L bytes (ELARA_NOTE_MAX_BYTES)" }`, MCP
  `create_note`/`edit_note` an `isError` result with the same text,
  import lists the note in `skipped`; a revert to a revision over the cap
  (and larger than the current body) is refused the same way. A rename
  checks every body its link rewrite changes (the note's own self-links,
  then each referrer's) before it writes anything: one over the cap
  refuses the whole rename, with the message naming the note (`renaming A
  to B rewrites its links in C: note body is …`). A referrer that grows
  past the cap between that check and its rewrite keeps its old link (the
  rename has happened; logged as `[rename] …`), and the other referrers are
  still rewritten. Restore of a full-instance backup
  is exempt (`export/restore.ts` inserts rows directly, not through
  `createNote`): dropping a backed-up note would lose it. The transport limit
  (`noteTransportLimit()` = 6 × cap + 64 KiB: a control character is 1
  byte of UTF-8 and 6 of JSON, the worst escaping; plus frontmatter) is
  the Fastify `bodyLimit` of the note create/update routes and `/mcp`,
  and the relay's ws `maxPayload`. In `updateNote` and
  `writeThroughCollab` the cap runs before the write quarantine (#492,
  below): an over-cap body is refused, never kept as a quarantine
  revision (which `revert_note` would then refuse). Before #491, REST
  and MCP refused only at Fastify's default 1 MiB *request* limit (so a
  body under 1 MiB with JSON escaping was refused), import took any size
  and the relay stored up to ws's 100 MiB default (60 MiB froze the
  server ~20 s in the lab).
- **Write quarantine** (`growth-guard.ts`, #492): a stale reload once
  doubled a whole note (#488) and the store wrote it like any edit. A body
  write is checked against the stored body (UTF-8 bytes, linear time:
  ~20 ms for a doubled 1 MiB note). *Growth*: the new body is ≥ 1.9× the
  stored one and the stored one is ≥ 2 KiB (a stub filled in is never
  flagged). *Repeated block*: both bodies are cut into content-defined
  chunks (gear rolling hash over the last 32 characters, cuts at ~1 in 64
  positions, 16..512 characters), so a copy of a passage is cut like the
  original wherever it starts, newline or not; the extra occurrences of
  chunks already in the stored body must add up to ≥ 1 KiB and ≥ half of
  it. MCP `edit_note` and REST `PUT /api/vaults/:id/notes/*` apply both
  rules in `writeThroughCollab` before the body reaches the live document;
  `allowGrowth: true` skips them. The collab relay's store applies the
  repeated-block rule only, inside `updateNote`'s note lock (a human's
  paste in the editor has no override channel; a doubled document is a
  repeated block whatever its size). Create, import, restore, rename and
  revert are not checked (no stored body, a backup, a deliberate restore).
  A suspicious write is not applied: `refuseSuspiciousWrite` records it as
  a `quarantine` revision with the full refused frontmatter and body and
  throws `NoteWriteQuarantinedError` (409 over REST with `quarantined:
  {revisionId, rule, previousBytes, nextBytes, repeatedBytes}`; an MCP
  tool error naming the rule, the revision id and `allowGrowth`). A write
  that continues a quarantine updates that revision instead of adding one:
  the relay keeps the quarantine revision id per loaded `Y.Doc` (a live
  document that stays doubled while someone types), so a document loaded
  afresh after an unload always adds a new revision and a new failure; an
  MCP/REST write continues only an identical retry of the newest quarantine
  by the same actor. `recordRevision`'s
  dedupe skips quarantine and proposal rows. Restore one
  with `revert_note` / the REST revert route.
- **Restore points** (`withRestorePoint` in `store.ts`, #482): the MCP
  write tools (`edit_note`, `rename_note`, `delete_note`, `revert_note`)
  run through `withRestorePoint(vaultId, path, connectionId, write)`.
  MCP is stateless Streamable HTTP (no session id), so a session is the
  connection on that note until it has recorded no revision there other
  than a quarantine or a proposal for `RESTORE_POINT_IDLE_MINUTES` (30). On the first write
  of a session it reads the database clock, then the stored row, and,
  only when the write returns a result, inserts a `restore_point`
  revision of that state attributed to the connection, dated at that
  clock read (so it sorts before the write's own revisions and every
  revision the row can contain sorts before it). It bypasses
  `recordRevision`'s dedupe (kept even when equal to the latest
  revision) and is skipped only when the latest revision other than a quarantine or a proposal
  already is this connection's restore point of the same state; it is
  never `recordRevision`'s dedupe baseline, so the connection's next
  write or delete is still recorded. Writes by one connection to one
  note are serialized (`restore-point:<connection>:<note id>` key lock,
  so also across a rename), so concurrent first writes keep one. A
  restore point that fails to insert (the note was purged in between) is
  logged and the landed write still succeeds. Unsaved relay typing is
  not in it (stored row only). A revert adds its own `revert` row and
  never relabels an earlier one, a restore point included (#479). History lists (`listRevisionPage`, `listRevisionMeta`)
  add `actorName` (the MCP connection's name, null otherwise; anyone with
  edit access to the vault sees it); the History tab labels a restore
  point "Before <name> edited".
- Every mutation is attributed (`Actor {type: 'user'|'mcp'|'collab',
  id?}`), which is what makes `noteRevisions` a real audit trail across
  the UI, MCP, and live-collaboration write paths.

### 5.4 Notifications (`server/src/notifications/`)

One function, `notify()`: writes an in-app row, then **best-effort**
sends an email (failures are swallowed, never block or fail the
request). Five trigger sites: vault shared/revoked, team membership
changed, note reverted, signup approved. No preferences/opt-out exists
— every trigger always fires both channels.
Routes (`routes.ts`), all scoped to the signed-in recipient:
`GET /notifications`, `POST /notifications/:id/read`,
`POST /notifications/read-all`, `DELETE /notifications/:id` (404 for
anyone else's row, 400 for a non-uuid id). The client panel is
`client/src/components/shell/NotificationBell.tsx`: per-row delete, a
close button, and a height-capped panel where only the list scrolls.
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
fully assembled graph on every call, seeded from the node ids. Its result
also depends on node and edge insertion order, so every query feeding it
(notes, repository files, note links, code imports, semantic edges) has
an `ORDER BY` on ids (#816): unordered, the row order followed the index
the planner picked, and two calls over the same data could differ. The merged cross-resource view
additionally requires the resource owner's `mergeable` flag and the
viewing user's own per-resource opt-in — three independent gates, all
re-resolved live.

**Saved perspectives** (`graph_perspectives`; REST `GET/POST
/graph/perspectives`, `DELETE /graph/perspectives/:id`, and the three MCP
perspective tools) follow one rule set, shared through
`perspective-access.ts` (#550). A vault perspective is listed to the
vault's readers when `isShared` (always to its creator); saving or deleting
one needs **edit** access to the vault (below that: 404 / MCP `not found`);
among editors the creator deletes their own and the vault owner any (else
403 / `owner permission required`). A global perspective (no vault) is
personal: only an instance admin (admin, superadmin, owner role) creates
one, and it is listed to and deleted by its creator only (anyone else, an
admin too, gets 404 / `not found`); `isShared` has no effect on it. A
global perspective whose creator is deactivated is therefore visible to
nobody (users are deactivated, not deleted, so the row stays). The graph
UI hides `+ Save view` and `Delete` from users these rules refuse.

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
  `EMBEDDINGS`. `LocalEmbedder` runs the model on at most 8 texts at a
  time, each cut to 16,000 characters: the pipeline pads a run to its
  longest text, so one large run costs ~32 MB per text (#404).
  Tokenisation and inference run in one `worker_threads` worker
  (`embedding-worker.ts`, #496), never on the main thread: an ONNX run
  blocks its thread for the whole batch (0.45 s per batch of 8 on a fast
  laptop, seconds on a lab runner), which on the main thread kept
  `/health` and every request waiting while a large file was embedded.
  One worker, one model copy, one batch in flight. The worker costs memory:
  its own V8 isolate and its own Transformers.js runtime and tokenizer
  (cause inferred, not profiled). In the lab's `docker stats` peaks the
  minified-bundle test went from 607/606/614 MiB on `dev` (runs
  38967769916, 39399916561, 38967768712) to 755/758 MiB (39400724898,
  39402040044), about +150 MiB, and the pretty-bundle test from
  1017/1037 MiB to 1324/1239 MiB, about +200 to 300 MiB under load (still
  under the lab's 3 GiB bound). Callers take turns batch by batch
  (round-robin over every active request), so a search query waits for
  one batch per other active caller (the note queue and the extraction
  queue: up to about 2 batches), plus the model load on first use. A worker that exits
  or dies on an uncaught exception fails the request whose batch it was
  running with `EmbeddingWorkerCrashError` (reported as an `embedding` job
  failure, see Error reports and metrics in §8) and the next batch starts a new worker; a batch
  the model itself rejects fails only its request. The worker is unref'd
  while idle, so it never keeps a script alive. It imports nothing from
  the repository, so it loads both under tsx (production's
  `node --import tsx`, inherited through `execArgv`) and under Node's own
  type stripping (vitest).
- **`embedding-queue.ts`**: durable jobs (#494, see **Durable jobs**
  below), kind `embed_note`, key `embed_note:<noteId>:<seq>` —
  `scheduleEmbedding()` never blocks the caller (notes/store.ts calls
  it fire-and-forget on create/update/revert); it inserts the job in
  the background and `flushEmbeddings()` awaits that insert and the
  drain. The job embeds the note as it is when it runs. A boot-time scan
  (`scheduleMissingEmbeddings`) adds a job (idempotently) for any live
  note with a null embedding, and re-runs the job of the note's current
  `seq` if it failed with an error (not a `LeaseExpired` crash loop),
  also when an earlier version left an embedding. `pnpm reindex` re-runs finished jobs
  (`enqueueEmbeddings(ids, 'finished')`). A failure is logged and
  retried with backoff, never stops the drain.
- **`semantic-edges.ts`**: `recomputeSemanticEdges()` — kNN against
  both notes and code, filtered to `similarity >= SEMANTIC_THRESHOLD`
  (default 0.75), capped to `SEMANTIC_K` (default 8) per node. Called
  from both the note embedding queue and the repository extraction
  queue — this is the shared mechanism, not two parallel ones.

### 5.7 Real-time collaboration (`server/src/sync/`)

- **`collab-server.ts`**: the Hocuspocus relay. Document name is
  `"<vaultId>/~<noteId>"` (ADR-003 S2b; `~` never occurs in a slug, client
  `collabDocName`). A path-named connection (`"<vaultId>/<path>"`, sent by a
  bundle from before S2b) is refused with reason `reload-required` and
  nothing it sends is stored; the editor shows "Reload to keep editing"
  and keeps the text (and its #720 browser copy, which it looks up under
  both the id name and the old path name after the reload). Loading reads
  the note's state from `note_crdt` + `note_updates` (seeding it when
  absent), never a file. A rename keeps every editor connected (same id)
  and moves the note's SSE viewers to the new path (a `moved` event);
  agent presence is looked up by note id. A delete or purge closes the
  note's editors right after it commits (`closeNoteEditors`, close code
  4410, reason `note-deleted`), and `onAuthenticate` refuses a note in the
  trash or purged with the same reason; the editor stops reconnecting, keeps
  the text in this browser and says the note is in the trash (status
  `deleted`). After a restore new connections are let in; a reload brings
  the kept typing back. `onAuthenticate` requires live `edit` access.
  **`beforeHandleMessage` re-resolves access on every inbound Yjs
  message**, not just at connect time — dropping below `edit` mid-session
  drops the next message and closes the connection.
- **A connection ends with its session** (#498). `POST /api/collab/ticket`
  binds the ticket (`tickets.ts`, single use, 60 s) to the user and the
  hash of the session asking; `onAuthenticate` refuses a ticket whose
  session ended or expired since, and keeps the session hash in the
  connection context (a raw session token, as server callers and tests
  use, keeps its own). When a session ends (§5.1) the relay closes every
  document connection opened with it, in every tab, with code 4401 /
  reason `signed-out`, and refuses any message already queued behind the
  close; `beforeHandleMessage` also re-checks the session with its 10 s
  access re-check (expiry, or a delete no event announced). Other
  sessions of the same user are untouched (a password change spares the
  session doing it). The editor (`useCollabDoc`) turns a `signed-out`
  close, or a 401 from the ticket endpoint, into status `signed-out`: it
  stops reconnecting, the editor turns read-only, the text stays on
  screen and in this user's browser copy, which a logout in this browser
  deletes (#720). The SSE live view (`viewers.ts`) ends with its
  session the same way. `onStoreDocument`
  debounces (default 2s) persistence back through the same OKF write
  path used everywhere else; a write that fails validation is logged
  and the last good file state is kept, never corrupted. A store whose
  body repeats a block of the stored note is quarantined (§5.3, #492):
  row and file keep the previous body, the live document and its
  editors keep the text (nobody is reverted or disconnected), the
  CRDT state keeps the typing (the delta stays in `note_updates` and
  `fold_error` says why the row did not take it), and a `collab-store` job failure is
  reported; the next store without the repeat is written normally. A
  store caused by a server body write through a direct connection
  (`writeThroughCollab`, context `directWrite`; its caller ran the check
  or passed `allowGrowth`) is not checked again. The flag is set at the
  end of the write's transaction, so a refused write (a check, an op that
  does not resolve, validation) still gets this check on its connection's
  disconnect store: a document a person doubled stays out of the row (#408).
- **Size cap on the relay** (#491, `collab-size.ts`): ws refuses a frame
  over `noteTransportLimit()` before reading it (close 1009).
  `beforeSync` refuses a sync-step-2 or update message whose Yjs update
  would leave the body over `ELARA_NOTE_MAX_BYTES` and larger than now
  *before* it is applied: Hocuspocus closes that document connection with
  reason `note-too-large` (code 4413), so the relay never holds or stores
  it. The check does not serialize the note per keystroke: each document
  keeps the body's bytes at the last exact measure (load, each store)
  plus the lengths of every update applied since, an upper bound because
  an update carries its inserted text as UTF-8; only when bound + update
  + Yjs's pending structs passes the cap does it measure exactly, and
  only when still over does it apply the update to a scratch copy (work
  bounded by the larger of the cap and the body). Updates that insert no
  text always pass; a body already over the cap may take an update that
  adds text as long as the result is no larger (an editor's reconnect
  sends its typing and its cuts in one update). The collab ticket returns
  `maxNoteBytes` and `maxFrameBytes` (= `noteTransportLimit()`); the
  editor (`useCollabDoc`) turns a `note-too-large` or 1009 close into
  status `too-large`: it stops reconnecting, keeps the text (on screen
  and in the browser's copy), shows how much to cut (`TooLargeNotice`,
  beside `UnmergedNotice` when both apply) and, once the body fits,
  syncs again on a new provider (the old one would replay its queued
  keystrokes one by one, and on a note over the cap the first that adds
  text is refused alone). When the whole document state would not fit
  through `maxFrameBytes` (the editor's undo history keeps deleted text,
  e.g. an undone paste), it first rebuilds the document from its own
  state: same history, so it still merges, but deleted text and the undo
  history are dropped (the notice says so); the browser's copy moves to
  the new document.
- **`permission-events.ts`**: an in-process `EventEmitter` bus.
  Every share/team/deactivation mutation calls `emitPermissionChange()`,
  and every session delete announces the ended sessions' hashes on it;
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
- **`agent-presence.ts`** (#481): agents in the editors' "In this note
  now" row. After an MCP `read_note` / `export_note` (reading) or
  `edit_note` / `revert_note` (editing), the relay adds an awareness
  state `{ agent: { name, activity } }` to that note's document, under
  a client id of its own per MCP connection, but only when the document
  is already loaded (a read never loads one). `name` is the MCP
  connection's label; the token, its hash and the connection id are
  never broadcast. The state has no `user` and no cursor. It stays
  `editing` until the idle timeout after the agent's last write, is
  renewed every 15 s (y-protocols drops remote states after 30 s) and is
  removed after `COLLAB_AGENT_IDLE_MS` (default 60000) without a read or
  write. `beforeHandleAwareness` strips `agent` from every state a
  client sends and drops client updates for an agent's client id, so
  only the relay can put an agent in presence.

### 5.8 MCP (`server/src/mcp/`)

- **Transport**: `POST /mcp` and `POST /elara/mcp` (same handler; unprefixed, not under `/api`). There is no stdio transport. The
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
  never silently narrowed or widened. The pin is structural (#546):
  every tool is registered through `tool(name, { scope, ids?, ... },
  handler)`, the wrapper resolves the scope before the handler runs and
  hands it the result (`{ vaultId }`, `{ repositoryId }`, `{ resources }`),
  and handlers never call `vaultFor`/`repositoryFor` themselves.
  `server.registerTool`, `server.tool`, `server.registerResource` and
  `server.resource` are replaced on the instance by a function that
  throws, so a tool registered without a declaration fails when the
  server is built. That is a guard against forgetting the declaration,
  not a security boundary: the low-level `server.server.setRequestHandler`
  would bypass it (here it is only wrapped, to filter `tools/list`).
  Scopes: `account` (account tokens only:
  `list_vaults`, `create_vault`, `restore_vault`, `purge_vault`, the two
  vault-preference tools, `list_repositories`, `connect_repository`, the
  team tools, `lookup_user`, the notification tools); `vault` (the note
  and vault tools); `repository` (the repository tools);
  `vault-or-account` (the three perspective tools: a vault token is
  confined to its vault and never sees or creates global perspectives;
  `delete_graph_perspective` applies the pin to the perspective's own
  vault via `ids`, and a pinned token gets `not found` for any perspective
  outside its vault, the same answer as for a missing id);
  `repository-or-account` (`find_symbols`: a vault token is refused, a
  repository token searches only its pin); `vault-or-repo` (`search`,
  `graph`, `find_graph_path`, via `resolveResourceSet`). `everywhere:
  true` needs an account token. Ids that come from stored data rather
  than arguments stay inside the pin too: `audit_okf_conformance` on a
  vault token reports every `[[repo:...]]` link as broken without
  looking the repository up (a vault pin reaches no repository).
  `test/mcp-scope.test.ts` takes its tool list from an admin account
  token's `tools/list` (a pinned token's list is filtered, #641), calls
  every tool with a vault-pinned and a repository-pinned token (another
  vault/repository id, no id, `everywhere`), checks that confined calls
  still return their own data, and fails on a tool with no case there:
  **a new tool needs a case there**.
- **Capabilities** (`server.ts`, #548, #549): every `tool()` also
  declares `capability: 'read' | 'write' | 'admin'`, and the wrapper
  checks the connection before the scope: the tool must be in
  `allowedTools` when that is set (`<tool> is not in this connection's
  tool allow-list`), and `access` must rank at or above the tool's
  capability (read < write < admin; `<tool> needs the admin capability;
  this connection has write access ...`). `admin` tools: share/revoke
  (vault and repository), `update_vault`, `update_repository`,
  `delete_vault`, `purge_vault`, `purge_note`, `purge_revision`,
  `connect_repository`, `delete_repository`, `add_team_member`,
  `remove_team_member`, `delete_team`. `write` tools create, edit,
  trash, restore or revert; the rest are `read`. A pinned token is
  `write` unless its owner minted it `admin`, so by default it cannot
  share, update, trash or purge its pin or erase history. A pinned
  token never gets more than its minter's permission on the pin (#649):
  `admin` only for the owner, `write` for an edit share on a vault or
  any access to a repository, `read` for a read-only vault share. An
  explicit `access` above that is refused (403, the message names the
  permission needed); an omitted one takes the pin default (`write`)
  lowered to it. Prompts are
  not registered for a connection with an allow-list (they read notes
  outside `tool()`). `tools/list` advertises only the tools the
  connection can call (#641): in its allow-list, within its access level
  and of a scope class its scope reaches (`account` tools for account
  tokens only, `vault`/`vault-or-account` not for repository tokens,
  `repository`/`repository-or-account` not for vault tokens). For a
  pinned token it also leaves out every tool whose `pinPermission` is
  above the user's live permission on the pin (#649): `owner` for the
  12 tools whose handler calls `requireVaultOwner` /
  `requireRepositoryOwner` (share listing, share, revoke, update,
  delete, both purges), `edit` for the 12 whose handler calls
  `requireAccess(…, 'edit')` (note writes, `list_trash`,
  `note_history`, `get_revision`, `export_vault`, saving and deleting perspectives),
  `read` (any access) for the rest; a repository viewer meets `edit`.
  The permission is read with one `resolveAccess` /
  `resolveRepositoryAccess` per `tools/list` (skipped for an account
  token or when the static filters leave nothing), so an ownership
  transfer, a share change or a token older than the mint cap is
  reflected on the next request; a user with no access left sees an
  empty list. Every tool
  stays registered, so calling a hidden one still returns the refusal
  above. `listMcpTools()` builds the catalog once from the
  registrations; `test/mcp-tool-capabilities.test.ts` pins the admin
  set and the `owner`/`edit` pin-permission sets (a new tool whose
  handler checks owner or edit permission must declare `pinPermission`),
  `test/mcp-capabilities.test.ts` covers each rule and
  `test/mcp-tool-visibility.test.ts` the filtered `tools/list`.
- **Tools** (60, all registered in `server.ts`; parameters and return
  shapes are documented in `skills/elara/references/mcp-tools.md`):
  - *Vaults* (14): `list_vaults`, `create_vault`, `browse_vault`, `update_vault`, `get_vault_graph_preference`, `set_vault_graph_preference`, `get_vault_preferences`, `update_vault_preferences`, `delete_vault`, `restore_vault`, `purge_vault`, `list_vault_shares`, `share_vault`, `revoke_vault_share`.
  - *Notes* (15): `read_note`, `create_note`, `edit_note`, `append_note`, `upsert_note`, `rename_note`, `delete_note`, `list_trash`, `restore_note`, `purge_note`, `note_history`, `get_revision`, `revert_note`, `purge_revision`, `audit_okf_conformance`.
  `note_history` is metadata only and paged (#411): `listRevisionPage()`
  selects id, actor, action, `created_at` and `octet_length(body)`
  (read from the stored value's header, the body is never loaded; one
  more query adds `actorName` for MCP rows, #482),
  keyset on `ord` descending (the order recorded, #825) over
  `note_revisions_note_ord (note_id, ord)`, `limit` default 20,
  max 100, one extra row to set `hasMore`. The opaque `cursor` is
  base64url JSON of the last row's `ord` (`{"ord":n}`; the `{at, id}`
  cursor from before #825 is refused as invalid), so a revision recorded
  while a caller pages shifts nothing. `get_revision` returns one
  revision's frontmatter and body (`getRevision()`, the same query as
  the REST revision route), gated like `note_history`. Both, and the
  REST history list, add `sourceRevisionId` / `fromPath` / `toPath`
  only on the rows that have them (#479; `sourceRevisionId` also on a
  `proposal`, #475), so a plain row costs no more.
  - *Repositories* (13): `list_repositories`, `connect_repository`, `browse_repository`, `read_file` (includes a symbol outline), `repository_status`, `sync_repository`, `update_repository`, `get_repository_graph_preference`, `set_repository_graph_preference`, `delete_repository`, `list_repository_shares`, `share_repository`, `revoke_repository_share`.
  - *Teams & Users* (7): `list_teams`, `create_team`, `list_team_members`, `add_team_member`, `remove_team_member`, `delete_team`, `lookup_user`.
  - *Export & Notifications* (4): `export_vault`, `export_note`, `list_notifications`, `mark_notification_read`.
  - *Search & Graph* (7): `search` (with `everywhere` mode), `find_symbols`, `graph` (nodes, extracted/structural/semantic edges, Louvain communities; filters `types`, `tags`, `aggregate`, `community`), `find_graph_path`, `list_graph_perspectives`, `save_graph_perspective`, `delete_graph_perspective`.
  - *Prompts*: 20, registered in `prompts.ts`.
  *(Security invariant: MCP connections cannot create new MCP connections or mint tokens).*
  Every handler is wrapped so thrown errors become a structured `isError`
  result instead of an uncaught exception. Input schemas are strict
  (#437): `tool()` wraps each zod shape with `strictArgs()`
  (`strict-input.ts`), so the SDK refuses an undeclared argument before
  anything runs, with a message that names it, suggests the parameter it
  probably meant (`content` → `body`, `vault_id` → `vaultId`) and lists the
  tool's parameters; tools/list advertises `additionalProperties: false`.
  A nested object field uses `strictArgs()` too (`save_graph_perspective`
  `filters`); free-form maps (`frontmatter`, the preference maps) are
  `z.record` and accept any key. `test/mcp-strict-args.test.ts` loops
  over every tool.
  `search` and `graph` call
  the exact same `searchNotes()`/`buildGraph()` functions the REST
  routes use — one implementation, not a parallel MCP-specific path.
- **Secret-scan guard** (`test/mcp-secret-scan.test.ts`, #577): CI calls
  every tool from `tools/list` and every prompt from `prompts/list`
  against a fixture world seeded with real secrets (git URLs with
  userinfo, a token-only non-GitHub URL, a query-string token, an
  `ssh://user:password@` remote, an explicit git credential, a webhook
  secret, a sync token, MCP and session tokens and their hashes, password
  hashes, a TOTP secret, credential ciphertexts, a legacy unscrubbed
  repository row whose `lastSyncError` holds an authenticated URL and the
  bare token). Reads run first as
  the owner, a viewer, a vault-scoped and a repository-scoped
  connection; writes and destructive calls follow as the owner, on
  throwaway fixtures. Every response (JSON parsed recursively, base64
  zips unpacked) fails on URL userinfo (also a long bare username),
  token-like query parameters, `gh[opsu]_` tokens,
  `x-access-token`, `-----BEGIN`, `sk-`/`AKIA` keys, `$argon2`/`$2b$`
  hashes and the exact fixture values; a pattern match is allowed only
  where the response carries it with at least 8 characters of context
  exactly as a user wrote it (note bodies, file contents), so a note
  mentioning a pattern does not exempt it in other fields (#593). Owner
  read steps name text their response must contain, so an empty result
  does not pass. A tool with no
  fixture step fails the test: **a new tool needs a step there**.
- **Agent skills**: `skills/elara/` (current) and `skills/chapters/`
  (legacy copy, kept consistent) give AI assistants navigation rules
  (Elara for cross-repo and natural-language questions, grep for exact
  strings in one repo), the 60-tool catalog (`references/mcp-tools.md`), slash
  commands (`/elara-*`, with `/chapters-*` aliases), the OKF rules
  (`references/okf-format.md`), the `/elara-map` protocol, and an
  always-active rule file (`rules/elara.md`).
- **Architecture decision — rejected client-side WebMCP**: Evaluated the W3C Web Machine Learning Community Group's `navigator.modelContext` proposal (`webmachinelearning/webmcp`) and decided against implementing client-side WebMCP. The server is deliberately headless and backend-first (`POST /mcp` via Fastify); AI coding agents use the MCP tools without needing a browser tab, DOM rendering, or frontend runtime (ADR-001).

### 5.9 Export & backup (`server/src/export/`)

- **Vault export**: zip with a manifest, requires `edit`-or-owner
  access ("a copy outlives later revocation" — read access isn't
  enough). Sessionless, time-boxed **export links**
  (`EXPORT_LINK_TTL_HOURS`, default 24h) for sharing outside the app.
  Entries: live notes as OKF `<path>.md`, `assets/<name>`,
  `manifest.json` (`formatVersion` 1, `vaultId`, `name`, `mergeable`,
  `shares`) and, per
  note live or trashed, `.elara/history/<noteId>.json`
  (`vault-history.ts`, #499): `path`, `createdAt`/`updatedAt`/`deletedAt`
  (microsecond UTC text), a trashed note's `frontmatter` + `body`, and
  `revisions` oldest first (`id`, `action`, `actorType`, `actorId`,
  `actorEmail` for user actors, `frontmatter`, `body`, `createdAt`, and
  on event rows (#479) `fromPath`/`toPath` or `sourceRevisionId`).
  An export (download, export link or MCP `export_vault`) therefore
  carries the vault's full history and trash, including the email of
  every past revision author, also of users who have since lost access.
- **Import** (`POST /api/import`): uploads a zip, creates a **new**
  vault with a **new** owner and new IDs, re-validates every note
  through the normal OKF write path, best-effort per note (an invalid
  note is skipped and reported, not fatal). Refused with 400 before any
  vault is created: a manifest `formatVersion` newer than the server's,
  or a history file with a time that is not a real UTC instant. Assets
  keep their archive file names (unsafe names, `.` and `..` are
  dropped); `.md` files under `assets/` stay attachments, never notes. Trashed notes are recreated in
  the trash, then live notes; each note with a history file gets the
  archive's revisions (new ids, original order and times; a revert's
  `sourceRevisionId` is pointed at the new id of the archived revision
  it names, or null when that one is not in the archive, as in archives
  exported before revision ids were) and its
  original created/updated/deleted times. A revision keeps its author
  only when that author is the importer (user id or email, or an MCP
  connection the importer owns); others keep the actor kind with no id,
  so an archive cannot attribute edits to another account. Attachment
  links `/api/vaults/<manifest vaultId>/assets/<name>` whose file came
  with the archive are pointed at the new vault in bodies, frontmatter
  strings, trash and revisions. Archives from before #499 (no
  `.elara/`, no manifest `vaultId`) import live notes only, and links to
  any vault id are rewritten when the file name is one of the archive's
  assets. Shares listed in the
  archive's `manifest.json` are **never granted by default** (#621):
  without `?applyShares=true` nothing is looked up or granted and every
  manifest share comes back in `skippedShares` with reason
  `not_requested`. With it, a share is granted only to an existing
  **active** user other than the importer (matched by email) or to the
  one team with that name, at `read` or `edit` (anything else is
  `invalid_permission`, so never above the importer's own owner
  access); each grant notifies the grantee and logs
  `vault_share_created` (detail `source: 'import'`). The response is
  `{ vaultId, imported, trashed, skipped, appliedShares, skippedShares }`
  (`imported` counts live notes, `trashed` notes recreated in the
  trash), each
  share `{ granteeType, grantee, permission, reason? }`, skip reasons
  `not_requested`, `invalid_entry`, `invalid_permission`,
  `no_active_user`, `importer`, `no_team`, `ambiguous_team`,
  `duplicate`. The Settings import form sends the flag only when its
  "Give the archive's collaborators access again" box is ticked.
  Instance restore is separate and restores shares as backed up.
- **Instance backup** (`GET /api/admin/backup`, admin-only; the
  scheduled run in `backup-service.ts` writes the same zip):
  `buildInstanceBackup()` in `archive.ts`, format 2
  (`backup-format.ts`, #409). `backup.json` (format, time, row count per
  table, and `parts`: SHA-256 + size of every other entry, #493) plus
  one `db/<table>.jsonl` per table in `BACKUP_TABLES`, read
  in one repeatable-read snapshot, rows as stored (TOTP secrets
  included, embeddings left out), plus `vaults/<id>/notes/<path>.md`,
  `trash/<note id>.md` and `assets/<file>`. Files are read after the
  snapshot: a note file that no longer matches its snapshot row (body,
  frontmatter key by key) is left out, and the restore writes it from
  the row; `backup.json` `notesFromRow` counts them and the restore plan
  warns. Not backed up: sessions,
  email tokens, export links, note links, semantic edges, embeddings,
  the repository file index, CRDT state (each rebuilt or reissued; the
  table is in `docs/self-hosting/backup.md`). `executeBackup` writes
  local backups (`BACKUP_LOCAL_PATH`) with `atomicWrite(..., { mode: 0o600 })`
  (temp file created and chmodded 600 before the content goes in, then
  renamed) in a directory made and chmodded 700, and chmods the backups
  already there to 600, whatever the umask (#409, #493; a chmod the
  server can't do is a warning, not a failed backup). The download
  (`GET /api/admin/backup`) is sent with `cache-control: no-store`.
- **Restore** (`server/src/export/restore.ts` +
  `server/src/scripts/restore-backup.ts`): **CLI only**
  (`pnpm restore-backup [--dry-run] <zip>`), deliberately **not** an
  HTTP endpoint — restoring over a live instance isn't a button.
  `restoreBackup()` validates (format, every entry against its
  `backup.json` SHA-256 and size with nothing missing or added — an
  archive without `parts`, format 1 or pre-#493, restores with a
  warning —, every table file, row counts,
  columns, references inside the archive, note paths, attachment names;
  `BackupInvalidError`), plans (per-table and per-file counts, conflicts;
  warnings for attachments on disk that differ, kept, and for note or
  trash files on disk that differ, replaced by the archive's version;
  `RestoreRefusedError`), then applies: rows in one transaction with
  `on conflict (primary key) do nothing`, files written atomically
  inside it (the files it created are removed if the transaction
  fails), `instance_restored` security event with the archive's
  SHA-256, then `index.md` regeneration. Runs on an empty instance
  only; anything else is refused, no override flag. On an instance
  whose marker for this archive exists it writes nothing
  (`plan.alreadyRestored`): rows and marker commit together, so there
  is nothing to resume, and a re-insert would revive rows deleted since
  (shares, purged notes, rotated MFA backup codes). It only regenerates
  a missing generated `index.md` there. The CLI prints counts, and for
  an unexpected error only the driver's message and code (a drizzle
  error's message carries the query parameters).
  Ids are the archive's — a true restore, not an import. Rows are
  inserted as stored, not re-validated through the OKF write path.
  Restored MCP and sync tokens keep working (their hashes are
  restored). Restored repositories get `last_synced_at`,
  `last_synced_commit` and `last_webhook_at` cleared so the next poll
  re-indexes git repositories. A
  format-1 archive (`account-dump.json`) still restores: notes get ids
  derived from vault and path, tokens pinned to a repository are left
  out with a warning.

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
   `POST /repositories/:id/webhook`, unprefixed) or the polling fallback
   (`scheduler.ts`, every `POLL_INTERVAL_MS`, default 5 min).
   `shouldPoll()` (a pure function, unit-tested on its own) skips a
   repository only while its last webhook delivery is younger than
   `WEBHOOK_STALE_THRESHOLD_MS` (default 10 min, 2× the poll interval)
   and its `syncStatus` is not `error`; a repository with no webhook, a
   stale one or a failed sync is polled every tick. `lastSyncedAt` takes
   no part: every successful webhook sync ends after its delivery, so
   "synced since the last webhook" once disabled polling for good (#410).
   An unchanged remote costs one `ls-remote`, not a clone.
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

**Remote URLs never hold a credential** (`git-remote.ts`, #383): a
`gitUrl` like `https://x-access-token:TOKEN@host/o/r.git` is split on
connect (REST and MCP): the URL is stored without userinfo and the
userinfo goes into `gitCredentialEncrypted` (an explicit
`gitCredential` wins). `ssh://user:password@` remotes are split the same
way; a bare ssh user (`ssh://git@host`) stays in the URL (#593). Userinfo
with an invalid percent sequence (`%zz`, a raw `50%off`) is kept in its
raw form rather than throwing, and goes back into the clone URL unchanged.
With no encryption key the connect is refused
rather than store the token in plaintext. `authenticatedUrl` puts
`user:password` or a bare token back for the clone. Sync errors are
redacted before they reach `lastSyncError` (served to viewers) or the
log: `redactGitSecrets` first removes any URL userinfo up to the last `@`
of the authority and every URL query and fragment value
(`?private_token=***`, `#access_token=***`, a bare `?***`), then the
credential (stored or still in the URL) in raw and URL-encoded forms; on
its own, the password of a `user:password` credential, and its user too
when that looks like a token (8+ characters and not a token-type name such
as `git` or `x-access-token`, compared lower-cased), since the legacy
GitHub `TOKEN:x-oauth-basic` form puts the token there. URL passes run
first so a short credential (user `s`, password `?`) cannot break the
URLs they match. A form made of `*` alone is not replaced, so redaction
is idempotent. The cost is quadratic on long error text (#644).
`scrubStoredGitCredentials()` runs at boot and moves credentials
out of remotes stored before the fix (idempotent; a row it cannot
encrypt keeps its URL and is warned about, but its `lastSyncError` is
still redacted). `repositoryFields` strips
userinfo for owners too and replaces query and fragment values with
`***`; viewers get the remote without userinfo, query or fragment
(`publicGitUrl`), and the client builds deep links from host and path
only. It serves `lastSyncError` through
`publicSyncError` (also used by the MCP `repository_status`), so a row
the scrub left alone does not serve its token through the error text
either (#577). A query-string token stays at rest in `gitUrl`: it is
not userinfo, so nothing moves it.

**Code extraction** (`extraction.ts`): `web-tree-sitter` (WASM), four
supported languages — TypeScript, JavaScript, Python, Go. Each
language's grammar is loaded from its own npm package's `.wasm` file;
parsers are cached and initialized once. Per language, a tree-sitter
query extracts import statements and top-level symbol declarations
(function/class/interface/type, per language's actual grammar).
Extraction is deferred until the *entire* sync batch has been
persisted (see §11 for why — this fixed a real ordering bug found via
live e2e testing, not unit tests). Symbol
rows (`repositoryFileSymbols`) are a per-file outline surfaced through
the MCP `read_file` tool — despite the schema comment calling them
"contains edges," they are **not** emitted as actual graph edges by
`buildGraph()`.

**Import resolution** (`import-resolution.ts`, #398): `resolveImportPath`
resolves a specifier only against files already known in the same
repository. Relative specifiers (`./x`, `../x`) and the `@/` alias
resolve; `@/` maps by convention to the importing file's package `src`
directory (the path up to its first `src` segment; no `src`, no
resolution — `tsconfig` paths are not read). TypeScript ESM specifiers
name the compiled output, so `.js` tries `.ts` then `.tsx`, `.jsx` tries
`.tsx`, `.mjs` tries `.mts`, `.cjs` tries `.cts`, before the literal
path, then the path plus `.ts/.tsx/.js/.jsx/.py/.go`, then
`<path>/index.<ext>`. Every other specifier (npm packages, stdlib) is
stored with no resolved target and produces no graph edge.
`backfillUnresolvedImports()` runs at boot and re-resolves every stored
import row whose target is still null with the current rules, so
repositories indexed before #398 gain their import edges without a
re-sync (unchanged files are never re-extracted).

**Extraction queue** (`extraction-queue.ts`): durable jobs (#494, see
**Durable jobs** below), kind `extract`, payload `{fileId,
repositoryId}`, key `extract:<fileId>:<contentHash>`; `syncRepositoryFiles`
enqueues the changed files in one statement after the batch is persisted.
Enqueueing a key whose job already succeeded runs it again (content went
back to an earlier version) under a new id, so it queues behind the
repository's pending files; a pending or failed job is left alone, and a
file id listed twice in a batch is enqueued once. One
serial worker, fair across repositories (#497): each turn claims at most
10 jobs (`EXTRACTION_TURN_FILES`) of one repository in enqueue order, then
the repository with claimable jobs that was served least recently goes
next (ties: oldest job), so a large repository's backlog delays another
repository's files by at most one turn per other busy repository, not by
the whole backlog; a repository's own files keep their order. A file
whose extraction throws is logged and retried with backoff; the drain goes on. A file
with a line longer than 1,000
characters (minified, bundled or generated code) gets its file embedding
but no symbols or imports. **Per-file budget** (#496): a file's symbols
are all stored, but only the first `ELARA_EMBED_MAX_SYMBOLS_PER_FILE`
(`config.embedMaxSymbolsPerFile`, default 256; `0` embeds none) get an
embedding; the rest have a null `embedding`, so `find_symbols` and
`search` find them by name and snippet only. Such a file records why in
`repository_files.embedding_note` (migration 0022; null when nothing was
capped, cleared by the next extraction under the budget), logs a
warning, and MCP `read_file` returns the text as `embeddingNote`. Changing
`ELARA_EMBED_MAX_SYMBOLS_PER_FILE` does not re-extract anything: a file
keeps the embeddings and note of its last extraction until its content
changes. With
each text cut to 16,000 characters, one file costs at most 1 + budget
texts (the 700 KB lab bundle with 900 declarations: 33 batches instead of
113). The boot-time scan
(`scheduleMissingExtractions`) adds a job, idempotently, for every file
with a null embedding that has none for its current content (rows from
before the jobs table; a re-sync only enqueues files whose content
changed, #404), re-runs the job of a file's current content if it failed
with an error (an outage that outlasted the retries; a restart repaired
that before #494 too), also for an updated file that kept the embedding
of its previous content, and wakes the worker. A job failed as `LeaseExpired` is not re-run
at boot, so a file whose extraction kills the process cannot crash every
boot. `repository_status` reports `filesPendingExtraction` (files whose
extraction for the current content is still to come: a pending job, or
no job and no embedding; 0 means extraction is finished) and
`extractionFailures: {total, files: [{path, attempts, lastError}]}` (all
files whose job for the current content gave up, counted in `total`, the
first 5 by path listed).

**Durable jobs** (`jobs/durable.ts`, ADR-003 S5, #494; table `jobs` from
migration 0021). A job is claimable when `done_at` is null and
`lease_until` is null or past. `claimJob` is one statement (`UPDATE … WHERE
id = (SELECT … ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)`) that sets
`lease_until = now() + 60 s` and `attempts + 1`, and only claims a job
with `attempts < MAX_JOB_ATTEMPTS`; `completeJob` sets `done_at` and
clears `last_error`; `failJob` stores `last_error` (error name and
message, or those of its `Error` cause, so a Drizzle "Failed query: <SQL>"
keeps the Postgres error; URL credentials redacted, at most 500
characters) and, as the table has no `run_after`, pushes `lease_until`
out by the backoff (1 min · 2^(attempt−1), at most 2 min: the three
attempts span about 3 minutes, so a short embedder or database outage
does not fail the backlog). After `MAX_JOB_ATTEMPTS` = 3 claims the job
gets `done_at` with `last_error` kept: that is "failed", and monitoring
gets one report then (earlier failures count as `repeated`). `attempts`
counts claims, so a job whose runs kill the process stops at 3 too:
before claiming, each drain runs `failCrashedJobs`, which marks failed
every job of its kind with 3 claims and an expired lease (`last_error`
`LeaseExpired: …`) and reports it once. A job running at a graceful
shutdown also keeps its claim (leases are not released). Crash recovery: a job a dead process held becomes claimable
when its lease runs out; every drainer is woken every 5 s
(`startJobPolling`, started at boot) for such jobs and for backoffs.
Boot deletes successful jobs finished more than 7 days ago
(`pruneFinishedJobs`); failed ones stay as the per-file and per-note
status. A job that outlives its lease while still running can run twice
only if a second process shares the database; extraction and embedding
are idempotent rewrites.

`docs/superpowers/specs/2026-07-18-repository-ingestion-design.md` and
`2026-07-18-code-graph-integration-design.md` are the full specs.

---

## 6. Security posture

- **Passwords**: Argon2id (`@node-rs/argon2` defaults).
- **Tokens** (sessions, email verification, password reset, MFA backup
  codes, MCP connections, repository sync tokens, export links):
  SHA-256-hashed at rest, raw value returned exactly once at creation.
- **Repository credentials / webhook secrets**: AES-256-GCM,
  reversible, no rotation. Never embedded in a stored or served
  `gitUrl` (#383).
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
- **Rate limiting & lockout**: global Fastify rate limit (1000/min), stricter limit on abuse-sensitive auth routes, per-connection MCP rate limit (120/min default), and automatic account/IP lockout with token invalidation after 5 failed 6-digit email verification attempts.
- **SSRF & git argument-injection defense**: `isSafeGitUrl(gitUrl)` blocks cloud metadata services (`169.254.169.254`, `metadata.google.internal`), RFC 1918 private/loopback IPs in production, argument flags (`-`), control characters, and file protocols across API routes, MCP tools, and clone workers.
- **SVG asset sandboxing**: `image/svg+xml` uploads served with `Content-Security-Policy: default-src 'none'; sandbox` and `Content-Disposition: attachment` to eliminate inline script execution vectors.
- **Mermaid preview XSS defense**: Initialized with `securityLevel: 'strict'`, `htmlLabels: false`, and SVG sanitized with `DOMPurify.sanitize(..., { USE_PROFILES: { svg: true, svgFilters: true } })`.
- **MFA setup protection**: `POST /api/mfa/setup` forbids re-setup when MFA is already enabled, requiring explicit verification before modifying second-factor state.
- **Mass assignment guards**: Fastify schema validation (`additionalProperties: false`) and explicit field destructuring on vault and repository update routes.
- **Secrets in backups** (SEC-06, revised by #409): the instance backup keeps password hashes, token hashes and TOTP secrets as stored (stripping the TOTP secret locked MFA users out after a restore), so the archive is as sensitive as the database; the setup token is never backed up. The scheduled local backup file is written with mode `0600` (through a temp file of the same mode) in a `0700` directory, whatever the umask (#493). The restore CLI prints counts, and only a driver message and code on errors. The `backup.json` digests (#493) are integrity checks, not a signature: they catch damage and truncation, not someone who can rewrite the whole archive.
- **OIDC host-header sanitization**: Validated against `APP_URL` and injection characters to protect authorization code callbacks.
- **Admin role hierarchy**: Strict `ROLE_RANK` enforcement preventing self-promotion or subordinate demotion of superadmins and instance owners.
- **Ingestion bounds**: Git clone ingestion capped to 1MB per file and 10,000 files, ignoring vendor directories (`node_modules`, `dist`, `.next`).
- **Global perspective guards**: Unvaulted graph perspectives are created only by instance admins and listed to and deleted by their creator only (#550; §5.5).
- Full findings and the design changes they drove:
  `docs/superpowers/specs/2026-07-12-security-audit-findings.md` and
  `docs/superpowers/specs/2026-09-28-security-audit-and-remediation.md`.

### 6.1 Token and account guarantees, and the tests that hold them (#552)

Each guarantee below is checked by a server test (`server/test/`) and,
where the parts must meet on a real instance, by the lab
(`lab/tests/access-behaviour.test.ts`, fast tier). Where Elara falls
short today, the server test pins today's behaviour and names the issue,
and the lab check is in `lab/known-defects.json` with that issue: the fix
flips both.

| guarantee | today | server test | lab check |
|---|---|---|---|
| A revoked MCP token is refused on the very next request (HTTP 401, every method) | holds | `mcp-token-lifecycle` | `revoked token: refused on the next request (HTTP 401)` |
| An expired token (`expires_at`, #640) is refused; a token cannot be minted already expired (400) | holds | `mcp-token-lifecycle` | `scoped-tokens`: `expired token rejected (HTTP 401)` |
| Deactivating a user stops all of that user's tokens on the next request | holds; deactivation revokes every connection (account, vault- and repository-pinned) and reactivation does not restore them (#646) | `mcp-token-lifecycle` | `deactivated user: their token is refused on the next request (HTTP 401)`, `reactivated user: the token revoked at deactivation stays refused (HTTP 401)` |
| Tokens are stored only as a SHA-256 hash; the raw token is in neither the token's `mcp_connections` row, the audit events naming that connection nor the connection listing | holds | `mcp-token-lifecycle` | `token stored only as its SHA-256 hash` |
| The MCP limit (`MCP_RATE_LIMIT`, default 120/min) refuses request N+1 with HTTP 429 | holds | `mcp-rate-limit` | `rate limit: request MCP_RATE_LIMIT+1 on one connection within a minute gets HTTP 429` |
| The limit is per connection, not per user: a user with N tokens gets N x the limit | holds (by design today) | `mcp-rate-limit` | `rate limit: counted per connection (another token of the same user is not limited)` |
| The 429 carries `Retry-After` and a JSON-RPC error body | **defect #440**: no header, body `{"error":"rate limit exceeded for this connection"}` | `mcp-rate-limit` (pins today's 429) | the two `rate limit: the 429 ...` checks (known defects) |
| B's search, graph, `find_symbols`, related-note edges (local graph, backlinks), notifications, perspective listings, vaults, repositories and teams name nothing of A's | holds | `account-separation` | `separation: B's ... names nothing of A's` (six checks) |
| `lookup_user` returns only `{id, email}` of an active account; deactivated and unknown emails answer alike | holds; any active account is found by exact email (sharing needs the id) | `account-separation` | `separation: B's lookup_user returns A's id and email only` |
| B gets the same answer for A's vault, repository, note, revision, share, notification, team, perspective or connection as for one that does not exist (every MCP tool, a list of REST routes, every prompt that takes a vault) | holds | `account-separation` | `separation: A's vault/repository answers B like a missing ...` |
| Semantic neighbours are chosen within the owner's reach | **defect #461**: the neighbour lookup spans every account; every read filters the stored edges | `account-separation` (inserts such an edge and checks B's reads) | `semantic edges are stored only between notes of the same account` (known defect) |
| Note text in a prompt sits in a separate, delimited data block, apart from the instructions | **defect #556**: `active_project_companion`, `prepare_task_context`, `test_gap_analysis` (bodies) and `plan_feature_implementation`, `explain_code_architecture` (snippets) put it inside their one user-role instruction message, after a heading and before the prompt's own instructions | `mcp-prompt-note-content` (pins today's placement) | `prompt note text: placed in a separate data block, not inside the instructions` (known defect) |

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

- **`docker compose up -d`** is the whole thing: the app image and
  Postgres, one published port, `depends_on: service_healthy` so the
  server does not run migrations against a database that is not up yet,
  and a named volume on `/data`.
- **`Dockerfile`** (repo root): two stages, `node:24-slim` both (Debian,
  not Alpine — `onnxruntime-node` and `sharp` need prebuilt glibc
  binaries).
  - *client stage*: `pnpm install --frozen-lockfile --filter
    @chapters/client`, then `vite build`.
  - *runtime stage*: `pnpm install --frozen-lockfile --filter
    @chapters/server`, the server source, and the built client copied to
    `/app/client/dist` — which is exactly where `config.clientDist`
    (`../../client/dist` from `server/src`) looks, so `CLIENT_DIST` needs
    no override. Filtering each install to one package keeps the client
    toolchain out of the runtime image and the server's native
    dependencies out of the build stage.
  - Both stages copy **all three** workspace `package.json` files before
    installing: pnpm validates `--frozen-lockfile` against the importers
    it finds on disk, and a missing workspace directory fails the install
    before it starts.
  - Installs `git` **and `ca-certificates`** via apt: `node:24-slim`
    ships neither, and `repositories/git-sync.ts` shells out to git for
    every clone and fetch. Without them the image builds, boots, serves
    the UI and reports healthy while every repository connection fails —
    git without a CA bundle dies on `server certificate verification
    failed. CAfile: none` for any https remote. Node's own fetch/TLS uses
    a bundle compiled into node and is unaffected, which is what makes
    this easy to miss.
  - Installs *and* runs as the unprivileged `node` user, so `/app` is
    owned by it without a `chown -R` layer duplicating the (large)
    `node_modules` tree — and the Transformers.js model cache, which
    lives under `node_modules`, stays writable at runtime.
  - Runs via `tsx` — the *only* execution path this app has ever used,
    dev and prod alike; there is no tsc-to-JS build. `node --import tsx`
    rather than `pnpm start`, so the server is PID 1 and `SIGTERM`
    reaches the shutdown handler in `index.ts` that flushes note edits
    still inside the collab store debounce.
  - `HEALTHCHECK` hits `/health` with `node -e` + `fetch` (no curl in
    `node:*-slim`, and an apt layer for it is not worth it).
  - Exposes **`3000` only**. The Yjs relay rides Fastify's own HTTP
    server at `/collab`; there is no second port.
- **`GET /health`** (root, not under `/api`, no login needed): runs
  `SELECT 1`, then answers `200`
  `{ status: 'ok', startedAt, bootId, version, lastShutdown, previousBootId }`, or `503`
  `{ status: 'error', error: 'Database unreachable' }`. The extra fields
  (#583, `server/src/lifecycle.ts`) let an outside monitor see a restart
  without host access, and hold nothing sensitive:
  - `startedAt`: process start (`performance.timeOrigin`), ISO 8601.
  - `bootId`: a UUIDv7 made once per process: random, and ordered by start
    time, so a later boot's id sorts after an earlier one (host clock
    permitting). A new value = a new process.
  - `version`: the commit the image was built from (`ELARA_VERSION`;
    `publish.yml` passes `github.sha` as a build arg, the Dockerfile bakes
    it into the env), or `null` for an image built without it.
    `ELARA_HEALTH_HIDE_VERSION=true` (`config.healthHidesVersion`, #638)
    leaves the key out of `/health` for an operator who does not want to
    publish the build commit; default shown. The boot log line keeps it.
    Any value other than unset, empty, `true` or `false` keeps it shown and
    warns once at boot (`readHealthHidesVersion` in `config.ts`).
  - `lastShutdown`: how the *previous* process on this `DATA_DIR` ended,
    read once at boot from `DATA_DIR/lifecycle.json`. `index.ts` writes it
    `running` first thing at boot (before migrations), and `stopped` (with
    the signal) only after the SIGTERM/SIGINT handler finished every flush
    (collab relay, Fastify, Postgres pool). Next boot: `stopped` →
    `graceful`; `running` → `unclean` (SIGKILL, OOM kill, crash, uncaught
    exception, a boot that died in migrations, a shutdown Docker cut
    short after its stop timeout, or a volume that went read-only under it,
    see below); missing or unreadable → `unknown`
    (first boot on this data directory).
    - A SIGTERM that arrives before `index.ts` installs its handlers
      (during migrations and the boot catch-ups, before `listen`) ends the
      process with Node's default action, so it reads as `unclean`: a
      redeploy of a container that is still booting shows as unclean.
    - The marker is written to a per-process temp file
      (`lifecycle.json.<pid>.tmp`) and renamed, so a kill mid-write leaves
      the previous marker.
    - If the `running` write fails (full or read-only volume), this boot
      reports `unknown` (the marker it read may be stale, left by an older
      process that failed the same way) and deletes the marker (unlink
      works on a full disk), so the next boot reports `unknown` rather than
      reading an older process's `stopped` as `graceful`. On a read-only
      volume the delete fails too, and every boot keeps reporting `unknown`
      while it stays read-only. The first boot after the volume is writable
      again reads whatever marker the last process before the read-only
      period left, with that process's bootId as `previousBootId`:
      `graceful` if it shut down cleanly before the volume went read-only
      (`stopped`), `unclean` if the volume went read-only under it (its
      `stopped` write failed, so `running` stayed; it may well have shut
      down cleanly). If a monitor checked during the read-only period, that
      `previousBootId` is not the bootId it last saw: the uptime monitor
      flags the restart `unseen` and says how the process it saw ended is
      not known, and an `unclean` also adds the `unclean-restart` label. If
      no check fell in that window, `previousBootId` is the bootId last
      seen, nothing is flagged, and the read-only boots go unreported.
      The boot log line carries the error as `markerError`.
    - It assumes **one process per `DATA_DIR`**, which the deployment is
      (single container; the collab relay and the queues are in-process,
      §9). A second process would overwrite the marker, and the verdict
      would be about whichever wrote last.
  - `previousBootId`: the `bootId` of the process `lastShutdown` is about
    (from the marker), or `null` when that is `unknown`. A monitor that
    last saw a different `bootId` missed a restart in between, and knows
    `lastShutdown` is not about the process it saw.
  - At boot `index.ts` also prints one JSON line,
    `{"event":"boot","bootId",...,"lastShutdown","previousBootId","previous":{bootId,startedAt,version,stoppedAt,signal},"markerError"}`.
  - The production monitor that reads these fields is
    `.github/workflows/uptime.yml` (`github-workflow.md`, Production uptime
    monitor).
- **Error reports and metrics** (#705, `server/src/monitoring/`;
  operator guide `docs/self-hosting/monitoring.md`):
  - `metrics.ts` is an in-process, bounded store. `app.ts` adds one
    `onResponse` hook that calls `recordRequest` for every finished
    request with the route template (`req.routeOptions.url`, never the
    URL; unmatched requests are `METHOD (other)`), status,
    `reply.elapsedTime`, `req.id` and the actor kind (`user` with a
    session, `token` with a `Bearer` header, else `anonymous`). The error
    handler hands a 5xx's error to it through a `WeakMap`. Per route it
    keeps request count, 5xx count, max and a latency histogram (fixed
    bucket bounds, `LATENCY_BUCKETS_MS`) in 15 one-minute slots; at most
    300 route keys in the window, then `METHOD (other)`. Totals since boot
    (requests, 5xx, job failures, per job kind succeeded/failed/repeated)
    and a ring of the last 50 error reports with a monotonic `seq`.
  - Jobs report through `recordJob(kind, 'ok' | { error, repeat? }, subjectId)`:
    `embedding` (`embedding-queue.ts`: success, or the third failed
    attempt, earlier ones as `repeat`; `embeddings.ts`: an embedding worker that died, subject null),
    `extraction` (`extraction-queue.ts`, per file: success, or the third
    failed attempt, earlier ones as `repeat`), `sync`
    (`syncGitRepository` and `syncLocalRepository` themselves, so every
    caller is covered, including an unsafe stored URL), `collab-store`
    (`collab-server.ts` `onStoreDocument`: a rejected `updateNote` or CRDT
    save; the file keeps its last valid version. A quarantined store
    (#492) is reported as `NoteWriteQuarantinedError` with the rule as
    `code`; stores that continue the same quarantine count as `repeated`),
    `backup` (the scheduled run in `startBackupScheduler`; an on-demand one is a 500).
    `repeat: true` only increments `jobs[kind].repeated`: no total, no
    ring record, no log line, so a dead remote, an expired credential or a
    broken backup destination is one report, not one per retry. Set for a
    sync of a repository whose `syncStatus` was already `error` (the
    poller in `scheduler.ts` retries those every `POLL_INTERVAL_MS`; the
    manual sync route and MCP `sync_repository` claim the row as
    `syncing` first, so they pass the status they read before the claim
    through `startSync(repo, previousStatus)` to
    `syncGitRepository`/`syncLocalRepository`), and for a scheduled backup
    that fails after the previous backup, scheduled or on demand, also
    failed (module flag `backupFailing` in `backup-service.ts`: set on any
    failure, cleared by any success).
  - A report holds route template, status, `durationMs`, `reqId`, actor
    (requests) or job kind and a UUID subject (note, file, repository,
    vault; anything else dropped), plus `error: {name, code}`, each
    format-checked. **Never the error message**: messages quote note text,
    note paths and URLs, and the credential redaction (`redactGitSecrets`,
    PRs #592/#643) recognises credentials, not note text; with no free text
    in a report there is nothing left for it to redact. Each report is also
    logged as one JSON line, `{"event":"server_error",...}` or
    `{"event":"job_failure",...}` (`console.error`). The existing
    `req.log.error(error)` and per-job `console.error` lines (full error,
    for debugging on the host) are unchanged.
  - **`GET /api/admin/monitoring`** (`routes.ts`): `metricsSnapshot()`:
    `{ bootId, startedAt, now, windowMinutes, totals, jobs, routes: [{route,
    count, serverErrors, p50Ms, p95Ms, p99Ms, maxMs}], errors, lastSeq }`.
    Percentiles are bucket upper bounds capped at `maxMs`. Access:
    `Authorization: Bearer $ELARA_MONITORING_TOKEN` (`config.monitoringToken`,
    a getter; at least 32 characters, else ignored with a boot warning;
    compared in constant time over SHA-256 digests, no session or database
    read), or an admin session (`requireAdmin`). Any `Authorization` header
    other than the token is `401`; no header and no admin session is
    `401`/`403`. `/health` is unchanged.
  - The uptime monitor reads it and alerts on new 5xx, failed jobs, slow
    routes and an endpoint that stops answering (`github-workflow.md`,
    Production uptime monitor); 5xx and failed jobs once per streak, not
    per run. Single-process, like the queues (§9); lost on restart, which
    `/health` reports.
  - Tests: `monitoring.test.ts` (a route error, an embedding, extraction,
    git sync and collab store failure each carrying a marker and a
    `ghp_` secret: reported with the right fields, neither in the endpoint
    nor the log lines; a repository that keeps failing reported once;
    access rules), `monitoring-metrics.test.ts` (bounds, percentiles,
    format checks, repeats); lab `monitoring-alerts`.
- **`server/.env.example`**: every environment variable, documented, in
  one place. For compose, copy it to `.env` at the **repo root** (that is
  the file compose interpolates); for a direct run, `server/.env` with
  `node --env-file`. Nothing in the app loads a `.env` by itself.
  - ⚠ **`SMTP_HOST` unset means mail is never sent.**
    `email/mailer.ts` pushes each message onto an in-process array and
    returns success, so signup verification and password reset return
    200 and are never delivered — silently, with no error anywhere. This
    is the single most dangerous misconfiguration in the product.
  - ⚠ **`DATA_DIR`** is where the notes are. They are files on disk, not
    rows in Postgres; a database backup does not back them up, and the
    default relative path lands in a container's writable layer.
  - ⚠ **`CREDENTIALS_ENCRYPTION_KEY`** (`openssl rand -hex 32`): without
    it private-repo credentials and webhook secrets cannot be stored, and
    there is no rotation story.
  - ⚠ **`SETUP_TOKEN` must be unset, not empty.** `bootstrap.ts` uses
    `config.setupToken ?? generateToken()` and `??` does not catch `''`,
    so an empty value becomes the real setup token. This is why
    `docker-compose.yml` uses the list form (`- SETUP_TOKEN`), which
    passes a variable through only when it is actually set, instead of
    `${SETUP_TOKEN:-}`, which would always set it to the empty string.
  - Others: `DATABASE_URL`, `PORT`, `CLIENT_DIST`, `EMBEDDINGS`,
    `CORS_ORIGIN`, `LOCAL_REPOS_ROOT`, `ELARA_MONITORING_TOKEN` (Error
    reports and metrics, above), `ELARA_NOTE_MAX_BYTES` (note body size
    cap, §5.3; a reverse proxy must pass bodies up to 6 × it + 64 KiB),
    `ELARA_EMBED_MAX_SYMBOLS_PER_FILE` (per-file symbol embedding budget,
    default 256, §5.10 extraction queue).
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
| Embedding and extraction jobs | `jobs/durable.ts`, `search/embedding-queue.ts`, `repositories/extraction-queue.ts` | jobs are shared through the `jobs` table (claims use `FOR UPDATE SKIP LOCKED`), but a job that runs past its 60 s lease can be claimed and run by another instance too (`completeJob`/`failJob` do not check the lease holder), and the per-repository fairness state (`lastTurn`) is per process |
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

**Restore a backup**: `pnpm -C server restore-backup [--dry-run] <path-to-zip>`
against an **empty** instance only — it refuses otherwise, by design;
a re-run on an instance already restored from the same archive writes
nothing (§5.9). There is no HTTP restore path and no override flag.
Restart the server afterwards so it computes the embeddings.

**Store migration dry run (ADR-003 S1)**: `pnpm -C server migrate-store
--dry-run [--report <file>] [--vault <uuid>]` reads every note row, `.md`
file and `.crdt` bin in one `REPEATABLE READ READ ONLY` transaction (only
pre-0021 columns, so it runs on a production copy before the upgrade) and
reports what the S2a/S2b backfill will do: per-note classes (`crdt`: what
the bin's text matches; `collab`: what the S2b backfill does with it,
`attach`/`set-aside`/`seed`/`has-state`), the file ≠ row
conflict list (Q5: the file wins; `row.updated_at` against the file mtime,
both hashes), files that will change bytes, files with no row, sizes and
timings.
It writes only the `--report` file, which it creates exclusively
before the walk (an existing file, a symlink or an unwritable directory
exits 2 at once; a failed run removes the file); without `--report` the
JSON goes to stdout. Without `--dry-run` it exits 2:
the backfill ships with S2a. Code: `server/src/notes/migrate-store.ts`.
Operator guide: `docs/self-hosting/migration.md`.

**Check note files**: `pnpm -C server check-notes` (or
`-- --vault <uuid>`) after a restore, a disk incident, or a deploy that
touched the note write path. It reads files directly, so it is the fast
way to audit every vault; doing the same over MCP is ~one call per note
under the 120/min per-connection limit. A note it reports as
`unparseable` is repaired by a full edit (frontmatter and body) or by
reverting it to a recorded revision (`note_history` → `revert_note`).
A `frontmatter-mismatch` or `body-mismatch` note (file and row disagree,
e.g. a crash or a failed file write after the row update, #486, or files
and database restored from different points in time) is repaired by a
full edit with the intended content, which rewrites both. On a running
server, an edit in flight between its row update and its file write also
shows as a mismatch for a moment: re-run the check (or `-- --vault
<uuid>`) before acting on a single mismatch, or run it while writes are
stopped.

**A quarantined write** (#492, §5.3): a `collab-store` report named
`NoteWriteQuarantinedError` (monitoring, subject = vault id) or an agent's
`quarantined` error. The note kept its previous body. The admin audit
trail (`GET /api/admin/audit-trail`) lists the revision with action
`quarantine` and the note's path; compare it with the note (`get_revision`
/ `read_note`): if it is real work rather than duplicated text,
`revert_note` to it (or edit the note with the part to keep); otherwise
nothing is to be done. A live editor that still shows duplicated text
keeps having its stores quarantined until the duplicate is deleted in the
editor.

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
check — every existing tool follows this pattern. Then add a fixture
step for it in `test/mcp-secret-scan.test.ts`; CI fails until you do.

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
- **A minified bundle most likely OOM-killed production (#404)**: extraction embedded
  a file and all of its symbols in one ONNX run. The pipeline pads every
  text in a run to 512 tokens, so memory grew ~32 MB per text; a 742 KB
  esbuild bundle yielded 947 symbols and a 948-text run peaking at
  30.7 GB RSS. The restart that followed dropped the rest of the
  in-memory queue, and nothing re-enqueued it. `LocalEmbedder` now runs
  at most 8 texts at a time, minified files get no symbols, and boot
  re-enqueues files that never got an embedding.
- **Embedding blocked the event loop (#496)**: after #404 the same bundle
  written one declaration per line (900 symbols, no minified guard) was
  embedded in 113 batches on the main thread; each ONNX run held the event
  loop, and on a slow runner `/health` missed its 3 s probe in 33 of 36
  samples (lab run 38967768712; a faster runner saw none, so the lab check
  was marked intermittent in #661). Embedding now runs in a worker thread
  and a file embeds at most 256 symbols.

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
