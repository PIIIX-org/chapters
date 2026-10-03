# Phase 6 — Database Persistence, Storage Volumes & Domain DNS Cutover

> **Status**: Planning — no execution until all phases approved  
> **Risk**: 🔴 Critical — production data, active sessions, DNS propagation  
> **Depends on**: Phases 1–5 completed and merged  
> **PR**: This document  

---

## 1. Scope & Objectives

Phase 6 is the final and highest-risk phase of the Chapters → Elara rebrand.
It covers three irreversible infrastructure layers:

1. **Database credentials & connection strings** — PostgreSQL role, database
   name, and every env var / config default referencing `chapters`.
2. **Physical disk storage & Docker volumes** — `DATA_DIR`, container paths,
   volume names, and temporary clone directories.
3. **Domain DNS & SSL cutover** — Public ingress from `chapters.piiix.org` to
   `elara.piiix.org`, CORS, OIDC callbacks, webhook URLs.

### Non-goals

- Schema migrations (no enums or columns store `chapters`; verified).
- Color / design token changes (invariant across all phases).
- Deleting historical documentation (archived, never deleted).

---

## 2. Database Credentials & Connection Strings

### 2.1 Current State — Exhaustive Inventory

| Location | Current Value | Line |
|---|---|---|
| [`server/src/config.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/config.ts#L20) | `'postgres://chapters:chapters@localhost:5432/chapters'` | L20 |
| [`server/.env.example`](file:///C:/Users/successbyte/Projects/chapters/server/.env.example#L23) | `DATABASE_URL=postgres://chapters:chapters@localhost:5432/chapters` | L23 |
| [`server/.env.example`](file:///C:/Users/successbyte/Projects/chapters/server/.env.example#L97-L99) | `POSTGRES_USER=chapters`, `POSTGRES_PASSWORD=chapters`, `POSTGRES_DB=chapters` | L97–99 |
| [`docker-compose.yml`](file:///C:/Users/successbyte/Projects/chapters/docker-compose.yml#L70) | `DATABASE_URL=postgres://${POSTGRES_USER:-chapters}:${POSTGRES_PASSWORD:-chapters}@db:5432/${POSTGRES_DB:-chapters}` | L70 |
| [`docker-compose.yml`](file:///C:/Users/successbyte/Projects/chapters/docker-compose.yml#L107-L109) | `POSTGRES_USER: ${POSTGRES_USER:-chapters}`, same for PASSWORD, DB | L107–109 |
| [`docker-compose.yml`](file:///C:/Users/successbyte/Projects/chapters/docker-compose.yml#L120) | `pg_isready -U ${POSTGRES_USER:-chapters}` | L120 |
| [`.github/workflows/ci.yml`](file:///C:/Users/successbyte/Projects/chapters/.github/workflows/ci.yml#L19-L25) | `POSTGRES_USER: chapters`, `POSTGRES_PASSWORD: chapters`, `POSTGRES_DB: chapters`, `pg_isready -U chapters` | L19–25 |

### 2.2 Schema Enums — Verified Brand-Neutral

All 11 PostgreSQL enums in [`server/src/db/schema.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/db/schema.ts) store functional classifications, not brand names:

`user_status`, `user_role`, `team_role`, `grantee_type`, `permission`, `mcp_scope`, `email_token_purpose`, `actor_type` (`'user' | 'mcp' | 'collab'`), `semantic_node_type`, `repository_ingestion_method`, `repository_sync_status`.

**Zero database migrations required.**

Only 3 lines in `schema.ts` mention "Chapters" — all in JSDoc comments (L460, L534, L536).

### 2.3 Transition Specification

#### 2.3.1 `config.ts` Dual-Read Fallback Engine

```typescript
// server/src/config.ts L20
databaseUrl:
  env.ELARA_DATABASE_URL
  ?? env.CHAPTERS_DATABASE_URL
  ?? env.DATABASE_URL
  ?? 'postgres://chapters:chapters@localhost:5432/chapters',
```

**Rationale**: The hardcoded default `postgres://chapters:chapters@localhost:5432/chapters` MUST remain as the final fallback. Production and existing docker-compose deployments initialized their PostgreSQL containers with `POSTGRES_USER=chapters` / `POSTGRES_DB=chapters`. Changing this default without the dual-read chain would cause immediate `password authentication failed` crash loops on every existing installation that relies on the default.

#### 2.3.2 Docker Compose Defaults

```yaml
# docker-compose.yml — env defaults change from chapters → elara
# BUT the actual values are interpolated from .env, so existing
# deployments with POSTGRES_USER=chapters continue to work.

environment:
  - DATABASE_URL=postgres://${POSTGRES_USER:-elara}:${POSTGRES_PASSWORD:-elara}@db:5432/${POSTGRES_DB:-elara}

db:
  environment:
    POSTGRES_USER: ${POSTGRES_USER:-elara}
    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-elara}
    POSTGRES_DB: ${POSTGRES_DB:-elara}
  healthcheck:
    test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER:-elara}']
```

> **⚠ CRITICAL**: Changing compose defaults only affects **new** installations.
> Existing installations have their PostgreSQL data volume already initialized
> with user `chapters` / db `chapters`. The `POSTGRES_PASSWORD` is baked into
> the volume on first creation. Operators upgrading must either:
>
> 1. Keep `POSTGRES_USER=chapters` / `POSTGRES_DB=chapters` in their `.env` (works forever via dual-read), OR
> 2. Create a new PostgreSQL role + database and migrate data (operator runbook provided below).

#### 2.3.3 CI Workflow

```yaml
# .github/workflows/ci.yml — ephemeral CI container, safe to change
services:
  db:
    env:
      POSTGRES_USER: elara
      POSTGRES_PASSWORD: elara
      POSTGRES_DB: elara
    options: >-
      --health-cmd "pg_isready -U elara"
```

CI creates a fresh container per run — no persistence concern.

#### 2.3.4 `.env.example` Updates

```env
DATABASE_URL=postgres://elara:elara@localhost:5432/elara
POSTGRES_USER=elara
POSTGRES_PASSWORD=elara
POSTGRES_DB=elara
SMTP_FROM=elara@localhost
```

#### 2.3.5 SMTP From Default

```typescript
// server/src/config.ts L46
from: env.SMTP_FROM ?? 'elara@localhost',
```

#### 2.3.6 Operator Migration Runbook (Optional)

For operators who want to fully rename their database:

```sql
-- 1. Create new role (while connected as superuser)
CREATE ROLE elara WITH LOGIN PASSWORD 'new_secure_password';

-- 2. Rename database (requires no active connections)
ALTER DATABASE chapters RENAME TO elara;

-- 3. Grant ownership
ALTER DATABASE elara OWNER TO elara;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO elara;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO elara;

-- 4. Update .env
-- ELARA_DATABASE_URL=postgres://elara:new_secure_password@db:5432/elara
```

---

## 3. Physical Disk Storage & Docker Volumes

### 3.1 Current State — Exhaustive Inventory

| Location | Current Value | Line |
|---|---|---|
| [`docker-compose.yml`](file:///C:/Users/successbyte/Projects/chapters/docker-compose.yml#L72) | `DATA_DIR=/data/chapters` | L72 |
| [`docker-compose.yml`](file:///C:/Users/successbyte/Projects/chapters/docker-compose.yml#L73) | `LOCAL_REPOS_ROOT=/data/chapters/local-repos` | L73 |
| [`docker-compose.yml`](file:///C:/Users/successbyte/Projects/chapters/docker-compose.yml#L102) | `chapters-data:/data` | L102 |
| [`docker-compose.yml`](file:///C:/Users/successbyte/Projects/chapters/docker-compose.yml#L127) | `chapters-data:` (named volume) | L127 |
| [`Dockerfile`](file:///C:/Users/successbyte/Projects/chapters/Dockerfile#L52) | `mkdir -p /app /data/chapters` | L52 |
| [`Dockerfile`](file:///C:/Users/successbyte/Projects/chapters/Dockerfile#L77) | `ENV DATA_DIR=/data/chapters` | L77 |
| [`Dockerfile`](file:///C:/Users/successbyte/Projects/chapters/Dockerfile#L78) | `ENV LOCAL_REPOS_ROOT=/data/chapters/local-repos` | L78 |
| [`server/.env.example`](file:///C:/Users/successbyte/Projects/chapters/server/.env.example#L36-L37) | `DATA_DIR=/data/chapters`, `LOCAL_REPOS_ROOT=/data/chapters/local-repos` | L36–37 |
| [`server/src/repositories/git-sync.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/repositories/git-sync.ts#L54) | `join(tmpdir(), 'chapters-repo-clones', ...)` | L54 |

### 3.2 How Notes Are Stored on Disk

[`server/src/notes/store.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/notes/store.ts#L68-L78) constructs paths from `config.dataDir`:

```typescript
function vaultDir(vaultId: string): string {
  return join(config.dataDir, 'vaults', vaultId)
}
```

Notes live at `${DATA_DIR}/vaults/${uuid}/${type}/${name}.md`. The path is **entirely UUID-based** — no brand name in the note file paths themselves. Only `DATA_DIR` contains the brand.

### 3.3 Transition Specification

#### 3.3.1 Dockerfile Symlink Bridge

```dockerfile
# Dockerfile L52 — create both directories, symlink old → new
RUN mkdir -p /app /data/elara \
 && ln -s /data/elara /data/chapters \
 && chown -R node:node /app /data
```

**Invariant**: `/data/chapters` symlinks to `/data/elara`. Any code path still referencing `/data/chapters` (including operator scripts, monitoring, rsync crontabs) transparently resolves to the new location.

```dockerfile
# Dockerfile L77–78
ENV DATA_DIR=/data/elara
ENV LOCAL_REPOS_ROOT=/data/elara/local-repos
```

#### 3.3.2 Docker Compose Volume Transition

```yaml
# docker-compose.yml
services:
  app:
    environment:
      - DATA_DIR=/data/elara
      - LOCAL_REPOS_ROOT=/data/elara/local-repos
    volumes:
      - elara-data:/data

volumes:
  db-data:
  elara-data:
```

> **⚠ CRITICAL — Volume Migration for Existing Deployments**:
>
> Renaming from `chapters-data` to `elara-data` creates an **empty** volume.
> Existing notes live in the old `chapters-data` volume. Operators must either:
>
> **Option A — Symlink (zero-downtime, recommended)**:
> ```bash
> # Keep using the old volume name in docker-compose.yml
> volumes:
>   elara-data:
>     name: chapters-data   # ← reuse existing volume under new alias
> ```
>
> **Option B — Copy and cutover**:
> ```bash
> docker compose down
> docker volume create elara-data
> docker run --rm \
>   -v chapters-data:/from -v elara-data:/to \
>   alpine sh -c 'cp -a /from/. /to/'
> docker compose up -d
> ```

#### 3.3.3 Temporary Clone Directory

```typescript
// server/src/repositories/git-sync.ts L54
const workDir = join(tmpdir(), 'elara-repo-clones', randomBytes(8).toString('hex'))
```

This is a throwaway `/tmp` directory — existing `chapters-repo-clones` directories are cleaned up by the OS. No migration concern.

#### 3.3.4 `.env.example` Updates

```env
DATA_DIR=/data/elara
LOCAL_REPOS_ROOT=/data/elara/local-repos
```

#### 3.3.5 `docker-compose.yml` Comment Updates

All comments referencing "Chapters" updated to "Elara":
- L1: `# One-command Elara: the app and its database.`
- L24: `# The `elara-data` volume holds the notes.`
- Other inline comments.

---

## 4. Backup & Disaster Recovery

### 4.1 Current State — Exhaustive Inventory

| Location | Current Value | Line |
|---|---|---|
| [`server/src/config.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/config.ts#L83) | `'chapters-backups/'` (S3 prefix default) | L83 |
| [`server/src/export/backup-service.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/export/backup-service.ts#L79) | `/^chapters-backup-.*\.zip$/` (local prune regex) | L79 |
| [`server/src/export/backup-service.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/export/backup-service.ts#L128) | `` `chapters-backup-${timestamp}.zip` `` (filename) | L128 |
| [`server/src/export/routes.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/export/routes.ts#L224) | `"chapters-account-export.zip"` (Content-Disposition) | L224 |
| [`server/src/export/routes.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/export/routes.ts#L236) | `"chapters-backup.zip"` (Content-Disposition) | L236 |
| [`server/test/backup-service.test.ts`](file:///C:/Users/successbyte/Projects/chapters/server/test/backup-service.test.ts) | 17 references to `chapters-backup-*` and `chapters-backups/` | Multiple |

### 4.2 Transition Specification

#### 4.2.1 Backup Filename

```typescript
// server/src/export/backup-service.ts L128
const filename = `elara-backup-${timestamp}.zip`
```

#### 4.2.2 Local Prune — Dual-Pattern Recognition

```typescript
// server/src/export/backup-service.ts L79
// Must recognize BOTH old and new backup filenames for pruning
const backupFiles = entries
  .filter((name) => /^(chapters|elara)-backup-.*\.zip$/.test(name))
  .sort()
  .reverse()
```

**Rationale**: Operators who upgrade will have a mix of `chapters-backup-*.zip` and `elara-backup-*.zip` in their backup directory. The pruner must count and rotate all of them, or old backups will accumulate forever.

#### 4.2.3 S3 Prefix Default

```typescript
// server/src/config.ts L83
return env.BACKUP_S3_PREFIX ?? 'elara-backups/'
```

> **Note**: Operators with existing S3 backups under `chapters-backups/` should set `BACKUP_S3_PREFIX=chapters-backups/` explicitly to continue pruning old backups. New installations will default to `elara-backups/`.

#### 4.2.4 Content-Disposition Headers

```typescript
// server/src/export/routes.ts L224
.header('content-disposition', 'attachment; filename="elara-account-export.zip"')

// server/src/export/routes.ts L236
.header('content-disposition', 'attachment; filename="elara-backup.zip"')
```

#### 4.2.5 Test File Updates

All 17 references in `server/test/backup-service.test.ts` updated from `chapters-backup` → `elara-backup` and `chapters-backups/` → `elara-backups/`, plus adding test cases for the dual-pattern local pruner.

#### 4.2.6 Pre-Flight Snapshot Protocol

Before executing Phase 6 on any production instance:

```bash
# 1. Full database dump
docker compose exec db pg_dump -U ${POSTGRES_USER:-chapters} ${POSTGRES_DB:-chapters} \
  > chapters-pre-rebrand-$(date +%Y%m%dT%H%M%S).sql

# 2. Full note volume snapshot
docker run --rm -v chapters-data:/data -v $(pwd):/backup \
  alpine tar czf /backup/chapters-data-pre-rebrand-$(date +%Y%m%dT%H%M%S).tar.gz /data

# 3. Verify both files are non-empty
ls -la chapters-pre-rebrand-*.sql chapters-data-pre-rebrand-*.tar.gz
```

---

## 5. Server Identity, Emails & Notifications

### 5.1 Current State — Exhaustive Inventory

| Location | Current Value | Line |
|---|---|---|
| [`server/src/index.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/index.ts#L23) | `"Chapters one-time setup token: ..."` | L23 |
| [`server/src/index.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/index.ts#L61) | `"Chapters server listening on ..."` | L61 |
| [`server/src/mcp/server.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/mcp/server.ts#L71) | `new McpServer({ name: 'chapters', version: '0.1.0' })` | L71 |
| [`server/src/auth/mfa.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/auth/mfa.ts#L12) | `issuer: 'Chapters'` (TOTP) | L12 |
| [`server/src/auth/routes.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/auth/routes.ts#L125) | `subject: 'Chapters: verify your email'` | L125 |
| [`server/src/auth/routes.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/auth/routes.ts#L281) | `subject: 'Chapters: password reset'` | L281 |
| [`server/src/auth/admin-routes.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/auth/admin-routes.ts#L212) | `'Your Chapters account has been deactivated by an admin.'` | L212 |
| [`server/src/auth/admin-routes.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/auth/admin-routes.ts#L233) | `'Your Chapters account has been reactivated by an admin. You can now log in.'` | L233 |
| [`server/src/notifications/notify.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/notifications/notify.ts#L33) | `` `Chapters: ${input.type.replaceAll('_', ' ')}` `` (fallback subject) | L33 |
| [`server/src/email/welcome.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/email/welcome.ts#L13-L49) | 4 occurrences of "Chapters" in welcome email | L13, 15, 17, 49 |

### 5.2 Transition Specification

#### 5.2.1 Startup Banner

```typescript
// server/src/index.ts L23
console.log(`\n=== Elara one-time setup token: ${setupToken} ===\n`)

// server/src/index.ts L61
console.log(`Elara server listening on :${config.port} (collab on ${COLLAB_PATH})`)
```

#### 5.2.2 MCP Server Identity

```typescript
// server/src/mcp/server.ts L71
const server = new McpServer({ name: 'elara', version: '0.1.0' })
```

> **Note**: Existing MCP clients (Gemini, Claude, Cursor) connect via HTTP
> POST to `/mcp`. The server name is exchanged during initialization
> negotiation — clients may log the new name but should not break. No
> dual-name needed; the protocol is name-agnostic for routing.

#### 5.2.3 TOTP Issuer

```typescript
// server/src/auth/mfa.ts L12
issuer: 'Elara',
```

> **⚠ WARNING**: Changing the TOTP issuer does NOT invalidate existing TOTP
> secrets. The `issuer` field affects the label displayed in authenticator
> apps (e.g., "Elara:user@example.com" instead of "Chapters:user@example.com")
> but does NOT change the TOTP algorithm or validation. Existing enrolled users
> continue to authenticate successfully — they will see the old "Chapters"
> label in their authenticator app until they re-enroll. No forced re-enrollment
> required.

#### 5.2.4 Transactional Email Subjects

```typescript
// server/src/auth/routes.ts L125
subject: 'Elara: verify your email',

// server/src/auth/routes.ts L281
subject: 'Elara: password reset',

// server/src/notifications/notify.ts L33
subject: emailSubject ?? `Elara: ${input.type.replaceAll('_', ' ')}`,
```

#### 5.2.5 Admin Notification Messages

```typescript
// server/src/auth/admin-routes.ts L212
message: 'Your Elara account has been deactivated by an admin.',

// server/src/auth/admin-routes.ts L233
message: 'Your Elara account has been reactivated by an admin. You can now log in.',
```

#### 5.2.6 Welcome Email

All 4 occurrences in [`server/src/email/welcome.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/email/welcome.ts):

```
L13: 'Welcome to Elara — your account is active'
L15: 'Your Elara account has been approved...'
L17: 'Elara is a second brain you own...'
L49: 'You are getting this because you created an Elara account...'
```

#### 5.2.7 Existing Notification Backfill (Non-blocking)

```sql
-- Run once, after deployment, in a maintenance window
UPDATE notifications
SET message = REPLACE(message, 'Chapters', 'Elara')
WHERE message LIKE '%Chapters%';
```

This is cosmetic and non-blocking. Old notifications in users' feeds will show "Chapters" until this runs. No data loss if skipped.

---

## 6. Domain DNS & SSL Cutover

### 6.1 Current State

- **Public domain**: `chapters.piiix.org`
- **APP_URL**: Set via environment; used by OIDC callbacks, email verification links, password reset links.
- **CORS origins**: Configured via `CORS_ORIGIN` in `server/src/config.ts` L50.
- **Webhook URLs**: GitHub/GitLab webhooks POST to `https://chapters.piiix.org/api/repositories/:id/webhook`.
- **OIDC redirect URI**: `${APP_URL}/auth/callback` (assembled in [`oidc-routes.ts`](file:///C:/Users/successbyte/Projects/chapters/server/src/auth/oidc-routes.ts#L48-L56)).

### 6.2 Transition Specification

#### 6.2.1 DNS & SSL

1. **Create DNS record**: `elara.piiix.org` → same IP/load balancer as `chapters.piiix.org`.
2. **Issue SSL certificate**: Let's Encrypt / Cloudflare for `elara.piiix.org`.
3. **Dual-domain window**: Both domains resolve for minimum 30 days.
4. **After grace period**: `chapters.piiix.org` → HTTP 301 Permanent Redirect to `elara.piiix.org/*`.

#### 6.2.2 Application URL

```env
APP_URL=https://elara.piiix.org
```

#### 6.2.3 CORS — Dual-Origin During Transition

```env
CORS_ORIGIN=https://elara.piiix.org,https://chapters.piiix.org
```

After the 301 redirect is confirmed working and DNS has propagated:

```env
CORS_ORIGIN=https://elara.piiix.org
```

#### 6.2.4 OIDC Redirect URI

The OIDC callback URL is derived from `APP_URL` in `oidc-routes.ts`:

```typescript
function callbackUrl(req: FastifyRequest): string {
  if (config.appUrl) {
    return `${config.appUrl.replace(/\/$/, '')}/auth/callback`
  }
  // ... falls back to request headers
}
```

**Action**: Register `https://elara.piiix.org/auth/callback` as an allowed redirect URI in the identity provider. Keep `https://chapters.piiix.org/auth/callback` registered during the transition window.

#### 6.2.5 Webhook URL Updates

GitHub/GitLab webhooks must be updated per-repository to point to `https://elara.piiix.org/api/repositories/:id/webhook`. During the dual-domain window, the 301 redirect handles this transparently for GitHub (which follows redirects). GitLab webhooks may require manual update.

#### 6.2.6 Nginx/Cloudflare Redirect Configuration

```nginx
server {
    listen 443 ssl;
    server_name chapters.piiix.org;
    
    # After grace period
    return 301 https://elara.piiix.org$request_uri;
}
```

---

## 7. CI/CD & Container Registry

### 7.1 Current State

| Location | Current Value | Line |
|---|---|---|
| [`.github/workflows/publish.yml`](file:///C:/Users/successbyte/Projects/chapters/.github/workflows/publish.yml#L42) | `ghcr.io/piiix-org/chapters` | L42 |
| [`.github/workflows/publish.yml`](file:///C:/Users/successbyte/Projects/chapters/.github/workflows/publish.yml#L1-L2) | Comments referencing `chapters-cloud` | L1–2 |

### 7.2 Transition Specification

```yaml
# .github/workflows/publish.yml L42
images: ghcr.io/piiix-org/elara
```

> **⚠ CRITICAL**: The `chapters-cloud` provisioner pulls `ghcr.io/piiix-org/chapters:<version>`.
> Changing the image name requires coordinating with `chapters-cloud` to update its
> pull target. During transition:
>
> 1. Publish to BOTH `ghcr.io/piiix-org/chapters` AND `ghcr.io/piiix-org/elara` (multi-tag).
> 2. Update `chapters-cloud` provisioner to pull from `elara`.
> 3. Deprecate the `chapters` image tag after all customers are migrated.

---

## 8. Package Names & Dockerfile References

### 8.1 Current State

| Location | Current Value |
|---|---|
| `package.json` (root) | `"name": "chapters"` |
| `client/package.json` | `"name": "@chapters/client"` |
| `server/package.json` | `"name": "@chapters/server"` |
| [`Dockerfile`](file:///C:/Users/successbyte/Projects/chapters/Dockerfile#L23) | `pnpm install --frozen-lockfile --filter @chapters/client` |
| [`Dockerfile`](file:///C:/Users/successbyte/Projects/chapters/Dockerfile#L28) | `pnpm --filter @chapters/client build` |
| [`Dockerfile`](file:///C:/Users/successbyte/Projects/chapters/Dockerfile#L60) | `pnpm install --frozen-lockfile --filter @chapters/server` |

### 8.2 Transition Specification

Covered by Phase 4 specification (PR #348). Included here for completeness — the Dockerfile `--filter` flags must be updated in lockstep with the `package.json` name changes:

```dockerfile
# After Phase 4 package rename
RUN pnpm install --frozen-lockfile --filter @elara/client
RUN pnpm --filter @elara/client build
RUN pnpm install --frozen-lockfile --filter @elara/server
```

---

## 9. Repository Comments & JSDoc (Code-Only)

These are source-code comments and JSDoc annotations. They carry zero runtime risk but should be updated for consistency.

| File | Lines | Content |
|---|---|---|
| `server/src/db/schema.ts` | L460, L534, L536 | JSDoc: "connected to Chapters", "never authored in Chapters" |
| `server/src/repositories/permissions.ts` | L64 | Comment: `chapters:ghp_token@github.com` |
| `docker-compose.yml` | L1, L24, etc. | Header comments |
| `Dockerfile` | L65, L74, etc. | Inline comments |
| `server/.env.example` | L35, etc. | Inline comments |

**Strategy**: Bulk find-and-replace `Chapters` → `Elara` in comments only, with manual review to ensure no false positives.

---

## 10. Execution Order & Rollback

### 10.1 Execution Order (Strict Sequence)

```
Step 1: Pre-flight snapshot (§4.2.6)
Step 2: DNS — create elara.piiix.org A record
Step 3: SSL — issue certificate for elara.piiix.org
Step 4: Deploy code changes (all §2–§5 in one commit)
         - config.ts dual-read fallback
         - Dockerfile symlink bridge
         - docker-compose volume alias
         - Backup dual-pattern pruner
         - All string replacements
Step 5: Set APP_URL=https://elara.piiix.org
Step 6: Set CORS_ORIGIN=https://elara.piiix.org,https://chapters.piiix.org
Step 7: Register OIDC callback for elara.piiix.org
Step 8: Update chapters-cloud provisioner image target
Step 9: Verify — full smoke test on elara.piiix.org
Step 10: Enable 301 redirect on chapters.piiix.org (after 30-day dual window)
Step 11: Run notification backfill SQL (§5.2.7)
Step 12: Publish dual-tag container image (§7.2)
```

### 10.2 Instant Rollback Runbook

If any step fails after deployment:

```bash
# 1. Revert to pre-rebrand code (git revert or deploy previous tag)
docker compose pull  # pulls the previous image
docker compose up -d

# 2. Restore APP_URL to chapters.piiix.org
# 3. Restore CORS_ORIGIN
# 4. DNS: elara.piiix.org can remain (harmless), no 301 was enabled yet

# If database was touched (notification backfill):
docker compose exec db psql -U chapters chapters -c \
  "UPDATE notifications SET message = REPLACE(message, 'Elara', 'Chapters') WHERE message LIKE '%Elara%';"

# If volume was migrated (Option B):
docker compose down
# Swap volume mount back to chapters-data in docker-compose.yml
docker compose up -d
```

**Recovery time**: < 5 minutes for code revert, < 15 minutes for full rollback including database.

---

## 11. Files Modified — Complete Manifest

| # | File | Changes |
|---|---|---|
| 1 | `server/src/config.ts` | Dual-read DATABASE_URL, SMTP_FROM default, S3 prefix default |
| 2 | `server/src/db/client.ts` | No changes (reads from config) |
| 3 | `server/src/db/schema.ts` | JSDoc comments only (3 lines) |
| 4 | `server/src/index.ts` | Startup banner (2 lines) |
| 5 | `server/src/mcp/server.ts` | McpServer name (1 line) |
| 6 | `server/src/auth/mfa.ts` | TOTP issuer (1 line) |
| 7 | `server/src/auth/routes.ts` | Email subjects (2 lines) |
| 8 | `server/src/auth/admin-routes.ts` | Notification messages (2 lines) |
| 9 | `server/src/notifications/notify.ts` | Fallback email subject (1 line) |
| 10 | `server/src/email/welcome.ts` | Welcome email (4 lines) |
| 11 | `server/src/export/backup-service.ts` | Filename, prune regex (2 lines) |
| 12 | `server/src/export/routes.ts` | Content-Disposition headers (2 lines) |
| 13 | `server/src/repositories/git-sync.ts` | Temp directory name (1 line) |
| 14 | `server/src/repositories/permissions.ts` | Comment only (1 line) |
| 15 | `server/test/backup-service.test.ts` | Test fixtures (17 lines) |
| 16 | `docker-compose.yml` | Volume, env defaults, comments (~15 lines) |
| 17 | `Dockerfile` | Paths, symlink, ENV, filter flags, comments (~8 lines) |
| 18 | `server/.env.example` | All defaults and comments (~10 lines) |
| 19 | `.github/workflows/ci.yml` | Postgres env (4 lines) |
| 20 | `.github/workflows/publish.yml` | Image name, comments (3 lines) |

**Total**: ~20 files, ~80 line-level changes.

---

## 12. Acceptance Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (including updated backup tests)
- [ ] Fresh `docker compose up` with NO `.env` file boots successfully with `elara` defaults
- [ ] Existing deployment with `POSTGRES_USER=chapters` boots successfully via dual-read fallback
- [ ] Backup filename matches `/^elara-backup-.*\.zip$/`
- [ ] Old `chapters-backup-*.zip` files are correctly counted by the dual-pattern pruner
- [ ] MCP server reports `name: 'elara'` during initialization
- [ ] TOTP validation continues to work for existing enrolled users
- [ ] Welcome email says "Elara" throughout
- [ ] `docker compose exec db psql` connects (verifying healthcheck and auth)
- [ ] Smoke test on `elara.piiix.org` — login, create note, collab, MCP connect
