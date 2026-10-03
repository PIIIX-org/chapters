# Phase 4: Workspace Package Names, Docker Orchestration & Dual-Read Environment Variables Plan

**Date**: 2026-10-03  
**Scope**: Complete technical specification for rebranding monorepo workspace packages, Docker container builds, volume persistence, temporary clone directories, backup archive patterns, and the universal dual-read environment variable engine from Chapters to **Elara**.  
**Related Vault Notes**: `rebranding/phase-4-package-names-docker-and-env-vars-plan`, `rebranding/phase-3-agent-skills-and-mcp-prompts-plan`, `rebranding/phase-2-client-presentation-and-storage-plan`, `rebranding/phase-1-brand-assets-plan`, `rebranding/blueprint-overall-plan`.  

---

> [!IMPORTANT]
> **Core Constraints Mandated by User**:
> 1. **Zero Downtime & Zero Data Loss**: Existing disk volumes (`chapters-data`) and environment files (`.env`) must continue functioning with transparent fallbacks.
> 2. **Name Replacement Only**: Update occurrences of "Chapters" to "Elara" across packages, containers, volumes, and configuration.
> 3. **Documentation Preservation**: Archiving historical records; zero file deletions.
> 4. **Approval Gate Active**: Strictly zero code execution until all planning phases are finished and approved.

---

## 1. Inventory of What Needs Changing in Phase 4

Across the build systems, container definitions, and configuration files, 8 primary files contain 32 references to Chapters:

| # | Component / Subsystem | File Location & Lines | Current State (`Chapters`) | Target State (`Elara`) |
| :---: | :--- | :--- | :--- | :--- |
| **1** | **Root Package** | `package.json:2` | `"name": "chapters"` | `"name": "elara"` |
| **2** | **Client Workspace Package** | `client/package.json:2` | `"name": "@chapters/client"` | `"name": "@elara/client"` |
| **3** | **Server Workspace Package** | `server/package.json:2` | `"name": "@chapters/server"` | `"name": "@elara/server"` |
| **4** | **Dockerfile** | `Dockerfile:23,28,52,60,77,78` | • `@chapters/client`<br/>• `@chapters/server`<br/>• `/data/chapters`<br/>• `DATA_DIR=/data/chapters` | • `@elara/client`<br/>• `@elara/server`<br/>• `/data/elara` (symlinked from `/data/chapters`)<br/>• `DATA_DIR=/data/elara` |
| **5** | **Docker Compose** | `docker-compose.yml:24,70,72,102,127` | • `chapters-data` volume<br/>• `POSTGRES_USER: chapters`<br/>• `DATA_DIR=/data/chapters` | • `elara-data` volume (with symlink fallback)<br/>• `POSTGRES_USER: elara`<br/>• `DATA_DIR=/data/elara` |
| **6** | **Server Configuration Engine** | `server/src/config.ts:20,46,83` | Fallbacks to `chapters` database and default SMTP/S3 | Universal dual-read `ELARA_*` $\leftarrow$ `CHAPTERS_*` fallback engine |
| **7** | **Temporary Clone Directory** | `server/src/repositories/git-sync.ts:54` | `join(tmpdir(), 'chapters-repo-clones', ...)` | `join(tmpdir(), 'elara-repo-clones', ...)` |
| **8** | **Backup Service & Export Names**| `server/src/export/backup-service.ts:79,128`<br/>`server/src/export/routes.ts:224,236` | • `chapters-backup-*.zip`<br/>• `chapters-account-export.zip` | • `elara-backup-*.zip` (supports both on restore)<br/>• `elara-account-export.zip` |
| **9** | **CI/CD Workflows** | `.github/workflows/ci.yml`<br/>`.github/workflows/okf-sync.yml`<br/>`.github/workflows/publish.yml` | • `POSTGRES_USER: chapters`<br/>• `--filter @chapters/server`<br/>• `ghcr.io/piiix-org/chapters` | • `POSTGRES_USER: elara`<br/>• `--filter @elara/server`<br/>• `ghcr.io/piiix-org/elara` |

---

## 2. Universal Dual-Read Environment Variable Engine

To guarantee zero downtime and eliminate deployment failures on servers configured with existing `.env` files, `server/src/config.ts` implements a dual-read fallback matrix:

```mermaid
flowchart TD
    Config["config.get('VARIABLE')"] --> CheckNew{"ELARA_VAR set?"}
    CheckNew -- Yes --> UseNew["Use ELARA_VAR value"]
    CheckNew -- No --> CheckLegacy{"CHAPTERS_VAR or Standard VAR set?"}
    CheckLegacy -- Yes --> UseLegacy["Use CHAPTERS_VAR / VAR value"]
    CheckLegacy -- No --> Default["Use Production Default"]
```

### Complete Environment Variable Fallback Specification (`server/src/config.ts`):

```typescript
const env = process.env

export const config = {
  port: Number(env.ELARA_PORT ?? env.CHAPTERS_PORT ?? env.PORT ?? 3000),
  appUrl: env.ELARA_APP_URL ?? env.CHAPTERS_APP_URL ?? env.APP_URL ?? env.BASE_URL ?? null,
  databaseUrl:
    env.ELARA_DATABASE_URL ??
    env.CHAPTERS_DATABASE_URL ??
    env.DATABASE_URL ??
    'postgres://elara:elara@localhost:5432/elara',
  dataDir: env.ELARA_DATA_DIR ?? env.CHAPTERS_DATA_DIR ?? env.DATA_DIR ?? './data',
  setupToken: env.ELARA_SETUP_TOKEN ?? env.CHAPTERS_SETUP_TOKEN ?? env.SETUP_TOKEN,
  credentialsEncryptionKey:
    env.ELARA_CREDENTIALS_ENCRYPTION_KEY ??
    env.CHAPTERS_CREDENTIALS_ENCRYPTION_KEY ??
    env.CREDENTIALS_ENCRYPTION_KEY,
  localReposRoot:
    env.ELARA_LOCAL_REPOS_ROOT ??
    env.CHAPTERS_LOCAL_REPOS_ROOT ??
    env.LOCAL_REPOS_ROOT ??
    './data/local-repos',
  smtp: (env.ELARA_SMTP_HOST ?? env.CHAPTERS_SMTP_HOST ?? env.SMTP_HOST)
    ? {
        host: (env.ELARA_SMTP_HOST ?? env.CHAPTERS_SMTP_HOST ?? env.SMTP_HOST)!,
        port: Number(env.ELARA_SMTP_PORT ?? env.CHAPTERS_SMTP_PORT ?? env.SMTP_PORT ?? 587),
        user: env.ELARA_SMTP_USER ?? env.CHAPTERS_SMTP_USER ?? env.SMTP_USER,
        pass: env.ELARA_SMTP_PASS ?? env.CHAPTERS_SMTP_PASS ?? env.SMTP_PASS,
        from: env.ELARA_SMTP_FROM ?? env.CHAPTERS_SMTP_FROM ?? env.SMTP_FROM ?? 'elara@localhost',
      }
    : null,
  corsOrigins: (env.ELARA_CORS_ORIGIN ?? env.CHAPTERS_CORS_ORIGIN ?? env.CORS_ORIGIN)
    ? (env.ELARA_CORS_ORIGIN ?? env.CHAPTERS_CORS_ORIGIN ?? env.CORS_ORIGIN)!.split(',').map((o) => o.trim())
    : [],
  backup: {
    get s3Prefix() {
      return env.ELARA_BACKUP_S3_PREFIX ?? env.CHAPTERS_BACKUP_S3_PREFIX ?? env.BACKUP_S3_PREFIX ?? 'elara-backups/'
    },
  },
}
```

---

## 3. Docker & Disk Volume Preservation Specification

In Chapters, vault notes are stored as plain files on physical disk (`/data/chapters`), not rows in PostgreSQL.

### Zero-Data-Loss Volume Strategy (`docker-compose.yml` & `Dockerfile`):
1. **Container Symlink**:
   Inside `Dockerfile`:
   ```dockerfile
   RUN mkdir -p /app /data/elara && ln -s /data/elara /data/chapters && chown -R node:node /app /data
   ```
   This ensures that any legacy path referencing `/data/chapters` resolves transparently to `/data/elara`.
2. **Volume Mount Transition**:
   - Primary volume named `elara-data` mounted to `/data`.
   - On existing instances where `chapters-data` exists: a one-line volume mount migration is documented (`docker volume create --name elara-data` followed by `cp -a /data/chapters/. /data/elara/`) without downtime.

---

## 4. Backup Service Backward Compatibility

In `server/src/export/backup-service.ts`:
- **Backup Generation**: Generates `elara-backup-${timestamp}.zip`.
- **Restore Filter**: Supports both formats:
  ```typescript
  .filter((name) => /^(?:elara|chapters)-backup-.*\.zip$/.test(name))
  ```
  This ensures any backups created under Chapters can be seamlessly inspected and restored in Elara.

---

## 5. Build & CI/CD Verification Plan

1. **Monorepo Build**:
   - `pnpm install` verifies workspace resolution with `@elara/client` and `@elara/server`.
   - `pnpm -r typecheck` verifies all TypeScript type references.
   - `pnpm -r test` verifies all unit tests across client and server.
2. **Docker Build**:
   - `docker build .` verifies multi-stage build caching, package filters, and directory symlinks.
