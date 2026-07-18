# Repository Ingestion & Permissions Implementation Plan

> **For agentic workers:** Executed inline in the same session that wrote
> this plan (full context, single implementer) — see
> `docs/agents/handling-protocols.md` for the working conventions
> (TDD, push-often, sandbox-only tests). No subagent dispatch needed.

**Goal:** Let a user connect a codebase to Chapters (git URL, local
path, or agent/CLI push), keep it synced, and share it read-only the
same way a vault is shared.

**Architecture:** A new `Repository` entity mirrors `Vault`'s owner/
share/team pattern (simplified to owner/viewer — nothing is ever
edited). Three ingestion methods converge on one shared sync/diff/
persist function (`syncRepositoryFiles`) so there's exactly one place
that writes `repositoryFiles` rows, regardless of source.

**Tech Stack:** Fastify + Drizzle/Postgres (existing). New: `simple-git`
(shallow clone/fetch, avoids hand-building git argv), `chokidar`
(filesystem watching) — both already proven, small, focused
dependencies. `node:crypto` (stdlib) for credential encryption, no new
dependency needed there.

## Global Constraints

(From `docs/agents/implementation.md` and
`docs/superpowers/specs/2026-07-18-repository-ingestion-design.md`.)

- Every DB query index-backed; every list endpoint paginated; nothing
  slow (git clone, embedding, etc.) on a request path — sync work runs
  async, request handlers return quickly.
- Permission checks are live, single indexed queries, never cached
  across requests — same posture as `resolveAccess` for vaults.
- Credentials for private git repos are **encrypted**, not hashed —
  they must be reusable for future pulls, unlike passwords/tokens.
- Repository files are **hard-deleted** on sync (no trash, no audit) —
  git is the source of truth for code history, not Chapters.
- Read-only: no write/edit/delete endpoint ever touches source content.
- Tests run against ephemeral local resources only (a throwaway
  Postgres schema, a temp directory, a local `file://` git remote) —
  no network access beyond localhost.

---

## File structure

```
server/src/
├── config.ts                        # + CREDENTIALS_ENCRYPTION_KEY, LOCAL_REPOS_ROOT
├── db/schema.ts                     # + repositories, repositoryShares,
│                                     #   repositoryGraphPreferences, repositoryFiles,
│                                     #   repositorySyncTokens
├── repositories/
│   ├── credentials.ts               # AES-256-GCM encrypt/decrypt (stdlib)
│   ├── permissions.ts               # resolveRepositoryAccess, listAccessibleRepositories
│   ├── store.ts                     # syncRepositoryFiles — the one write path
│   ├── routes.ts                    # Repository CRUD, shares, graph-preference REST
│   ├── sync-tokens.ts               # RepositorySyncToken issue/resolve/revoke
│   ├── push-routes.ts               # agent/CLI push ingestion endpoint
│   ├── local-watch.ts               # local-path ingestion (chokidar)
│   ├── git-sync.ts                  # git-URL ingestion (simple-git shallow clone/fetch)
│   ├── git-webhook-routes.ts        # GitHub/GitLab push-event receiver
│   └── scheduler.ts                 # polling fallback for unreachable webhooks
└── app.ts                           # mount repositories/push/webhook route groups
```

## Interfaces (so later tasks match earlier ones exactly)

```ts
// repositories/store.ts
export interface FileUpdate {
  path: string
  content: string
  sourceModifiedAt?: Date
}
export interface SyncResult {
  created: number
  updated: number
  deleted: number
  unchanged: number
}
export async function syncRepositoryFiles(
  repositoryId: string,
  changedOrNewFiles: FileUpdate[],
  currentPaths: string[], // full manifest at the source — anything indexed but absent here is deleted
): Promise<SyncResult>
export async function getRepositoryFile(repositoryId: string, path: string): Promise<RepositoryFileRow | null>
export async function listRepositoryFiles(repositoryId: string): Promise<Array<Pick<RepositoryFileRow, 'id' | 'path' | 'language' | 'size' | 'updatedAt'>>>

// repositories/permissions.ts
export type RepoAccess = 'owner' | 'viewer'
export async function resolveRepositoryAccess(userId: string, repositoryId: string): Promise<RepoAccess | null>
export async function listAccessibleRepositories(userId: string): Promise<Array<{ id: string; name: string; ownerId: string; mergeable: boolean; ingestionMethod: string; syncStatus: string; access: RepoAccess }>>

// repositories/credentials.ts
export function encryptCredential(plaintext: string): string
export function decryptCredential(blob: string): string

// repositories/sync-tokens.ts
export async function createSyncToken(repositoryId: string): Promise<string> // raw token, shown once
export async function resolveSyncToken(token: string): Promise<{ repositoryId: string; tokenId: string } | null>
export async function revokeSyncToken(repositoryId: string, tokenId: string): Promise<boolean>

// repositories/git-sync.ts
export async function syncGitRepository(repositoryId: string): Promise<void>

// repositories/local-watch.ts
export function startWatching(repositoryId: string, localPath: string): () => void // returns stop()

// repositories/scheduler.ts
export function shouldPoll(lastWebhookAt: Date | null, lastSyncedAt: Date | null, now: Date, thresholdMs: number): boolean
export function startPollingScheduler(intervalMs: number): () => void // returns stop()
```

`syncRepositoryFiles` computes `contentHash` (sha256) itself from
`content` — it never trusts a caller-supplied hash (the agent-push
client computes its own hash to decide what to *send*, but the server
re-derives from the bytes it actually received, both for correctness
and because trusting external hash claims buys nothing once the content
itself is already being verified).

## Tasks

### Task 1: Schema + migration

**Files:** Modify `server/src/db/schema.ts`; generate
`server/drizzle/0006_*.sql` via `pnpm db:generate`.

Add:
- `repositoryIngestionMethod` enum: `git` | `local_path` | `agent_push`.
- `repositorySyncStatus` enum: `idle` | `syncing` | `error`.
- `repositories`: id, name, ownerId (→users), ingestionMethod,
  gitUrl (nullable), gitCredentialEncrypted (nullable text), localPath
  (nullable), mergeable (bool, default false), syncStatus (default
  `idle`), lastSyncedAt (nullable), lastSyncError (nullable text),
  lastWebhookAt (nullable) — the scheduler's staleness signal,
  createdAt. Index on ownerId.
- `repositoryShares`: id, repositoryId, granteeType (reuse existing
  `granteeType` enum), granteeId, createdAt. Unique index on
  (repositoryId, granteeType, granteeId); index on (granteeType,
  granteeId) — same shape as `vaultShares` minus the permission column.
- `repositoryGraphPreferences`: userId, repositoryId, include (bool,
  default false). Composite PK — identical shape to
  `vaultGraphPreferences`.
- `repositoryFiles`: id, repositoryId, path, language (nullable),
  content, contentHash, size (integer), sourceModifiedAt (nullable),
  createdAt, updatedAt. Unique index on (repositoryId, path) — no
  soft-delete column, this table is hard-delete-on-sync.
- `repositorySyncTokens`: id, repositoryId, tokenHash (unique),
  createdAt, lastUsedAt (nullable), revokedAt (nullable).

- [ ] Add the tables/enums to `schema.ts`, following the exact style of
      the existing `vaults`/`vaultShares`/`vaultGraphPreferences`
      block (same file, same conventions — `pgTable`, `index`,
      `uniqueIndex`, `references(() => ..., { onDelete: 'cascade' })`).
- [ ] Run `pnpm db:generate` inside `server/`, confirm a new migration
      file appears under `server/drizzle/`.
- [ ] Commit: `git add server/src/db/schema.ts server/drizzle && git commit -m "Add repository schema"`.

### Task 2: Credential encryption

**Files:** Create `server/src/repositories/credentials.ts`; Test:
`server/test/credentials.test.ts`. Modify `server/src/config.ts` to add
`credentialsEncryptionKey` (from `CREDENTIALS_ENCRYPTION_KEY` env, a
32-byte key; generate a default random one on first boot the same way
the setup token is generated, and log-once if none is configured — for
tests, `vitest.config.ts` sets a fixed key).

- [ ] Write the failing test: encrypt→decrypt round-trips; two calls
      with the same plaintext produce different ciphertext blobs (IV
      randomness); a tampered blob throws on decrypt (GCM auth tag).
- [ ] Implement `encryptCredential`/`decryptCredential` using
      `createCipheriv('aes-256-gcm', key, iv)` / `createDecipheriv`,
      packing `iv:authTag:ciphertext` (each hex-encoded, colon-joined)
      into one string blob.
- [ ] Add `CREDENTIALS_ENCRYPTION_KEY` to `vitest.config.ts`'s test env
      (a fixed 32-byte hex string) so tests are deterministic.
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 3: Repository access resolution

**Files:** Create `server/src/repositories/permissions.ts`; Test:
`server/test/repository-permissions.test.ts`.

**Consumes:** `db`, `repositories`/`repositoryShares`/
`teamMemberships`/`users` schema tables.
**Produces:** `resolveRepositoryAccess`, `listAccessibleRepositories`
(signatures above) — every later task's permission guard calls these.

- [ ] Write failing tests mirroring `test/permissions.test.ts`'s shape,
      adapted to the two-tier model: owner resolves `'owner'`; no
      relationship resolves `null`; direct share resolves `'viewer'`;
      team share resolves `'viewer'`; deactivated user resolves `null`
      even as owner; revoking a share revokes access immediately
      (re-call after delete, assert `null`); leaving a team revokes
      team-granted access immediately.
- [ ] Implement `resolveRepositoryAccess` — same structure as
      `vaults/permissions.ts`'s `resolveAccess`: check user is active,
      check ownership, check direct share, check team share via join —
      just two tiers instead of three (no read/edit rank comparison
      needed, presence of any grant → `'viewer'`).
- [ ] Implement `listAccessibleRepositories` — same shape as
      `listAccessibleVaults`, minus the read/edit merge logic.
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 4: Repository CRUD, shares, graph-preference routes

**Files:** Create `server/src/repositories/routes.ts`; Test:
`server/test/repository-routes.test.ts`. Modify `server/src/app.ts` to
register the route group.

**Consumes:** `resolveRepositoryAccess`, `listAccessibleRepositories`
(Task 3), `encryptCredential` (Task 2).
**Produces:** REST surface other tasks' tests exercise end-to-end via
`app.inject`.

Endpoints (auth required, mirroring `vaults/routes.ts` patterns):
- `POST /api/repositories` — create; body `{name, ingestionMethod,
  gitUrl?, gitCredential?, localPath?}`. `gitCredential`, if present,
  is encrypted before storage and never returned by any GET.
  `localPath`, if present, must resolve under `config.localReposRoot`
  (reject otherwise — path-traversal guard, same posture as the OKF
  slug validation gives notes).
- `GET /api/repositories` — `listAccessibleRepositories(user)`.
- `GET /api/repositories/:id/access` — `{access}` or 404.
- `PATCH /api/repositories/:id` — owner-only; `{name?, mergeable?}`.
- `DELETE /api/repositories/:id` — owner-only; cascades (DB
  `onDelete: cascade` handles shares/files/tokens).
- `POST /api/repositories/:id/shares` / `GET .../shares` / `DELETE
  .../shares/:shareId` — owner-only management, mirroring
  `vaults/routes.ts`'s share endpoints exactly (including the
  team-share member-expansion on GET).
- `PUT /api/repositories/:id/graph-preference` — same "requires
  current access" guard as the vault version.
- `GET /api/repositories/:id/files` — `listRepositoryFiles` (Task 6),
  gated by `resolveRepositoryAccess(..., 'viewer')` minimum.

- [ ] Write failing tests: owner creates with each ingestion-method
      shape; non-owner cannot manage shares (404, not 403); grantee
      sees repo after share, not before; graph-preference requires
      current access; local path outside `localReposRoot` rejected;
      `gitCredential` never appears in any response body.
- [ ] Implement the route group.
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 5: Repository sync tokens

**Files:** Create `server/src/repositories/sync-tokens.ts`; routes
folded into `repositories/routes.ts` (`POST/.../sync-tokens`,
`POST .../sync-tokens/:id/revoke`, owner-only, mirroring
`vaults/mcp-connection-routes.ts`'s issue/list/revoke shape). Test:
extend `server/test/repository-routes.test.ts`.

**Produces:** `createSyncToken`, `resolveSyncToken`, `revokeSyncToken`
— consumed by Task 7 (push ingestion).

- [ ] Write failing tests: token shown once on creation, never again on
      list; `resolveSyncToken` returns null after revoke; only the
      repository owner can issue/revoke a token.
- [ ] Implement (hash token same as MCP connection tokens — reuse
      `hashToken`/`generateToken` from `auth/tokens.ts`).
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 6: Sync/diff/persist core

**Files:** Create `server/src/repositories/store.ts`; Test:
`server/test/repository-store.test.ts`.

**Produces:** `syncRepositoryFiles`, `getRepositoryFile`,
`listRepositoryFiles` — every ingestion method (Tasks 7–9) calls into
this; nothing else writes `repositoryFiles`.

- [ ] Write failing tests: first sync creates rows for every file in
      the batch; a second sync with one file's content changed updates
      only that row (`updated: 1, unchanged: N-1`); a second sync that
      omits a previously-seen path from `currentPaths` hard-deletes
      that row (`deleted: 1`); language is detected from extension
      (e.g. `.ts` → `'typescript'`); re-syncing identical content is a
      no-op (`unchanged` count, no `updatedAt` bump).
- [ ] Implement: for each `FileUpdate`, compute `contentHash =
      sha256(content)`; upsert on `(repositoryId, path)` conflict,
      skipping the write entirely if the existing row's hash already
      matches (no-op path); then delete any `repositoryFiles` row
      whose `path` isn't in `currentPaths`.
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 7: Agent/CLI push ingestion

**Files:** Create `server/src/repositories/push-routes.ts`. Test:
`server/test/repository-push.test.ts`. Modify `app.ts` to mount it.

**Consumes:** `resolveSyncToken` (Task 5), `syncRepositoryFiles`
(Task 6).

This is the simplest of the three ingestion methods — built first to
validate Task 6's sync/diff logic end-to-end before tackling git/fs
complexity.

- `POST /repositories/sync` — header `Authorization: Bearer <token>`;
  body `{files: [{path, content}], currentPaths: string[]}`. Resolves
  the token to a repository, calls `syncRepositoryFiles`, updates
  `lastSyncedAt`/`syncStatus`, returns the `SyncResult`.

- [ ] Write failing tests: valid token syncs files (verify via
      `listRepositoryFiles` afterward); revoked/unknown token → 401;
      a repository not created with `ingestionMethod: 'agent_push'`
      still accepts a push if it has a valid token (tokens aren't
      method-gated — a repo's ingestion method is informational about
      its *primary* source, not an enforced exclusivity).
- [ ] Implement the route.
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 8: Local path ingestion

**Files:** Create `server/src/repositories/local-watch.ts`. Test:
`server/test/repository-local-watch.test.ts`.

**Consumes:** `syncRepositoryFiles` (Task 6).

- [ ] Write failing test: point `startWatching` at a temp directory
      with two files; assert both synced (poll `listRepositoryFiles`
      with a bounded `waitFor`, matching the polling-assertion style
      already used in `collab.test.ts`); write a third file, assert it
      appears; delete one file, assert it's removed from
      `listRepositoryFiles`; call the returned `stop()`, write another
      file, assert it does **not** sync (watcher actually stopped).
- [ ] Implement `startWatching`: `chokidar.watch(localPath, {ignoreInitial: false})`,
      debounced (e.g. 300ms) batch of changed paths, read each file's
      content, walk the directory for the full current path list,
      call `syncRepositoryFiles`. Return `() => watcher.close()`.
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 9: Git URL ingestion

**Files:** Create `server/src/repositories/git-sync.ts`. Test:
`server/test/repository-git-sync.test.ts`.

**Consumes:** `decryptCredential` (Task 2), `syncRepositoryFiles`
(Task 6).

Tested against a **local bare git repo** (created in a temp dir via
`git init --bare`, populated by cloning+committing+pushing from a
second local working copy) used as the `gitUrl` — a `file://` path is
a fully valid git remote, so this is real git plumbing exercised
entirely offline, no network dependency.

- [ ] Write failing test: create a local bare repo with two committed
      files; `syncGitRepository` against it; assert both files appear
      via `listRepositoryFiles`. Commit a change (modify one file, add
      one, remove one) to the bare repo from a second working copy;
      run `syncGitRepository` again; assert the modification, the
      addition, and the deletion (hard-delete) all took effect.
- [ ] Implement: `simple-git().clone(url, workDir, ['--depth', '1'])`
      on first sync (or `.fetch()` + reset-to-latest on subsequent
      syncs, reusing the same scratch working directory keyed by
      `repositoryId` under a temp/scratch root — not `config.dataDir`,
      since this is a transient working copy, not canonical storage);
      walk the resulting tree for the full current file list and
      content; call `syncRepositoryFiles`; update
      `repositories.lastSyncedAt`/`syncStatus`, and `lastSyncError` on
      failure (private repo needing the decrypted credential injected
      into the clone URL, non-existent repo, etc.).
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 10: Webhook receiver

**Files:** Create `server/src/repositories/git-webhook-routes.ts`.
Test: `server/test/repository-webhook.test.ts`. Modify `app.ts`.

**Consumes:** `syncGitRepository` (Task 9).

- `POST /repositories/:id/webhook` — verifies an HMAC-SHA256 signature
  header (GitHub's `X-Hub-Signature-256` convention: `sha256=<hex>`
  over the raw body, using a per-repository webhook secret generated
  at repository-creation time and stored alongside `gitUrl`, same
  encrypted-at-rest treatment as the git credential). On a valid
  signature: updates `lastWebhookAt`, triggers `syncGitRepository`
  (fire-and-forget — the webhook response returns immediately, sync
  runs async, per the "nothing slow on a request path" rule). On an
  invalid signature: 401, security-logged.

- [ ] Write failing tests: correctly-signed payload → 200, and
      `lastWebhookAt` updates; wrong signature → 401, no sync
      triggered; missing signature header → 401.
- [ ] Implement the route + signature verification (`createHmac`,
      `timingSafeEqual` — same pattern already used for MCP token
      comparison in `auth/tokens.ts`'s `tokensEqual`).
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 11: Polling fallback scheduler

**Files:** Create `server/src/repositories/scheduler.ts`. Test:
`server/test/repository-scheduler.test.ts`. Modify `server/src/index.ts`
to start it alongside the HTTP/collab servers.

**Consumes:** `syncGitRepository` (Task 9).

- [ ] Write failing tests for the **pure** `shouldPoll` function only
      (the actual interval loop isn't directly unit-tested — thin
      wiring around a tested decision function, same split already
      used for `auth/lockout.ts`'s window logic): no webhook ever seen
      and never synced → poll; webhook seen recently (within
      threshold) → don't poll; webhook seen but stale (older than
      threshold) and no sync since → poll; synced more recently than
      the stale webhook → don't poll (a manual/agent-triggered sync
      already caught it up).
- [ ] Implement `shouldPoll` as a pure function (no I/O — exactly the
      signature above, comparing timestamps against `thresholdMs`).
- [ ] Implement `startPollingScheduler(intervalMs)`: `setInterval`,
      each tick queries `repositories` where `ingestionMethod = 'git'`
      and `syncStatus != 'syncing'`, filters by `shouldPoll`, calls
      `syncGitRepository` for each (sequentially, not concurrently —
      avoids a burst of parallel clones on a large instance). Returns
      a `stop()` that clears the interval.
- [ ] Wire into `index.ts` after `app.listen`, using a
      `POLL_INTERVAL_MS`/`WEBHOOK_STALE_THRESHOLD_MS` config pair
      (add to `config.ts`, sensible defaults e.g. 5 minutes / 10
      minutes).
- [ ] Run tests, confirm green.
- [ ] Commit.

## Self-review

**Spec coverage:** Repository/RepositoryShare/RepositoryGraphPreference/
RepositoryFile/RepositorySyncToken entities — Task 1. Access resolution
rule — Task 3. Owner-only share/config management — Tasks 3–4. All
three ingestion methods converging on one sync function — Tasks 6–9.
Webhook + polling fallback — Tasks 10–11. Encrypted (not hashed)
credentials — Task 2. Hard-delete-on-sync — Task 6. Local-path
allowlist scoping — Task 4. Read-only boundary — enforced by omission
(no task anywhere adds a write/edit endpoint for file content).

**Placeholder scan:** No TBD/TODO; every task names exact files and
either shows the interface or the concrete test behavior expected.

**Type consistency:** `RepoAccess`, `FileUpdate`, `SyncResult` are
defined once in the Interfaces section and referenced identically
across Tasks 3–11 — no renaming drift.

**Gap check against the spec:** the spec's "Assumptions carried
forward" section marks file-size caps and poll/webhook-staleness
intervals as implementation-time decisions — both are resolved
concretely above (thresholds as config with defaults; no file-size cap
added, matching the explicit note that content today, like note
content, has no cap either).
