# Chapters — Security Audit & Remediation Specification (2026-09-28)

A comprehensive source code security audit and penetration test review was executed across the full Chapters stack (Fastify backend, React frontend, Hocuspocus/Yjs collaboration relay, MCP server tools, and git sync engine).

All 12 discovered vulnerabilities have been systematically remediated at root cause following Ponytail senior engineering principles (zero extraneous abstractions, minimal surgical diffs, root-cause repair across all callers, and dedicated automated test suites).

---

## Vulnerability Overview & Resolution Matrix

| Finding ID | Title | CWE | CVSS v3.1 | Severity | Status | Verification Suite |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | Stored XSS in Mermaid Rendering | CWE-79 | **9.6** | Critical | **RESOLVED** | `client/src/hooks/mermaidDecorations.test.ts` (6/6) |
| **SEC-02** | Stored XSS via Direct SVG Asset Upload | CWE-79 / CWE-434 | **9.6** | Critical | **RESOLVED** | `server/test/assets.test.ts` (8/8) |
| **SEC-03** | Blind SSRF & Git Argument Injection | CWE-918 / CWE-88 | **9.1** | Critical | **RESOLVED** | `server/test/repository-permissions.test.ts` (16/16), `repository-routes.test.ts` (15/15) |
| **SEC-04** | MFA Second-Factor Bypass via Setup Reset | CWE-287 / CWE-306 | **8.1** | High | **RESOLVED** | `server/test/mfa.test.ts` (2/2) |
| **SEC-05** | Mass Assignment in Vault & Repo Update | CWE-915 | **7.5** | High | **RESOLVED** | `server/test/vaults.test.ts` (7/7) |
| **SEC-06** | Sensitive Plaintext 2FA Secrets in Backups | CWE-522 / CWE-312 | **7.4** | High | **RESOLVED** | `server/test/export.test.ts` (6/6) |
| **SEC-07** | Host Header Injection in OIDC Callback | CWE-601 / CWE-444 | **6.8** | Medium | **RESOLVED** | `server/test/oidc.test.ts` (10/10) |
| **SEC-08** | Inconsistent Admin Role Hierarchy Enforcement | CWE-269 | **6.5** | Medium | **RESOLVED** | `server/test/admin-dashboard.test.ts` (11/11) |
| **SEC-09** | Missing Lockout on 6-Digit Email Codes | CWE-307 | **5.3** | Medium | **RESOLVED** | `server/test/auth.test.ts` (8/8) |
| **SEC-10** | Unbounded Git Clone Ingestion DoS | CWE-400 | **5.3** | Medium | **RESOLVED** | `server/test/repository-scheduler.test.ts` (6/6) |
| **SEC-11** | Unrestricted Global Shared Perspectives | CWE-284 | **4.3** | Low | **RESOLVED** | `server/test/graph-perspectives.test.ts` (7/7) |
| **SEC-12** | Transitive Build and CLI Dependencies | CWE-1395 | **4.0** | Low | **RESOLVED** | `pnpm audit` (0 vulnerabilities) |

---

## Detailed Technical Remediation

### SEC-01: Stored XSS in Mermaid Diagram Rendering
- **Vulnerability**: The CodeMirror 6 live preview extension initialized Mermaid with `securityLevel: 'loose'`, injecting raw SVG via `viewport.innerHTML = svg`. Loose mode executes inline JavaScript embedded in click callbacks, HTML labels, and SVG `<script>` or event handlers.
- **Root-Cause Fix**:
  - Initialized Mermaid with `securityLevel: 'strict'` and `htmlLabels: false`.
  - Passed all generated SVG through `DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })`.
- **Files**: `client/src/hooks/mermaidDecorations.ts`
- **Tests**: `client/src/hooks/mermaidDecorations.test.ts` (6 tests).

### SEC-02: Stored XSS via Direct SVG Asset Upload & Insecure Serving
- **Vulnerability**: Vault asset uploads allowed `image/svg+xml`. Assets were served inline with permissive headers, allowing uploaded SVG files with embedded `<script>` tags to execute JavaScript in the victim's session origin.
- **Root-Cause Fix**:
  - Appended `Content-Disposition: attachment; filename="${req.params.fileName}"` when serving `image/svg+xml`.
  - Appended `Content-Security-Policy: default-src 'none'; sandbox` to prevent script execution even if forced inline.
- **Files**: `server/src/notes/routes.ts`
- **Tests**: `server/test/assets.test.ts` (8 tests).

### SEC-03: Blind SSRF & Git Argument Injection in Clone URL
- **Vulnerability**: `POST /api/repositories` and `connect_repository` accepted user-supplied `gitUrl` without schema or scheme validation and passed it directly to `git.clone(gitUrl, ...)`. This enabled `file:///` local disk extraction, cloud metadata querying (`169.254.169.254`), and command option injection via leading hyphens (`--upload-pack`).
- **Root-Cause Fix**:
  - Implemented `isSafeGitUrl(gitUrl)` validating protocols (`https://`, `http://`, `git://`, `ssh://`, `git@`), forbidding leading hyphens (`-`), null bytes, and control characters (`\r`, `\n`).
  - Blocked cloud metadata hosts (`169.254.169.254`, `metadata.google.internal`) and RFC 1918 private/loopback IP address ranges in production.
  - Guarded API routes, MCP tool `connect_repository`, and sync background clone workers.
- **Files**: `server/src/repositories/permissions.ts`, `server/src/repositories/routes.ts`, `server/src/mcp/server.ts`, `server/src/repositories/git-sync.ts`
- **Tests**: `server/test/repository-permissions.test.ts` (16 tests), `server/test/repository-routes.test.ts` (15 tests).

### SEC-04: MFA Second-Factor Bypass via Insecure Setup Reset
- **Vulnerability**: `POST /api/mfa/setup` immediately cleared `mfaEnabledAt = null` upon generating setup QR data, allowing an attacker with a stolen session to permanently disable 2FA without verifying password or TOTP.
- **Root-Cause Fix**:
  - Added check rejecting `POST /api/mfa/setup` with 400 if `user.mfaEnabledAt` is already active.
  - Preserved `mfaEnabledAt` during initial setup.
  - Repaired `setInstanceMfaRequirement` in `server/src/auth/mfa.ts` to upsert into `instanceState` table.
- **Files**: `server/src/auth/mfa-routes.ts`, `server/src/auth/mfa.ts`
- **Tests**: `server/test/mfa.test.ts` (2 tests).

### SEC-05: Mass Assignment in Vault & Repo Update Endpoints
- **Vulnerability**: `PATCH /api/vaults/:id` and `PATCH /api/repositories/:id` passed `req.body` directly to `db.update(...)`, allowing malicious users to overwrite protected fields (`ownerId`, `createdAt`, `deletedAt`).
- **Root-Cause Fix**:
  - Enforced `additionalProperties: false` in Fastify JSON schemas.
  - Explicitly destructured only permitted fields (`{ name, mergeable }`) before performing database updates.
- **Files**: `server/src/vaults/routes.ts`, `server/src/repositories/routes.ts`
- **Tests**: `server/test/vaults.test.ts` (7 tests).

### SEC-06: Sensitive 2FA Secrets & Hashes in Backup Archives
- **Vulnerability**: Full-instance export dumped user database rows directly into `account-dump.json` without scrubbing `totpSecret`.
- **Root-Cause Fix**:
  - Explicitly mapped exported user objects to enforce `totpSecret: null`.
- **Files**: `server/src/export/archive.ts`
- **Tests**: `server/test/export.test.ts` (6 tests).

### SEC-07: Host Header Injection in OIDC Callback URL
- **Vulnerability**: `callbackUrl(req)` constructed the OIDC redirect URI using untrusted `req.headers.host`.
- **Root-Cause Fix**:
  - Prefer `config.appUrl` when configured.
  - Sanitized `req.headers.host` against carriage returns, newlines, and non-host characters.
- **Files**: `server/src/config.ts`, `server/src/auth/oidc-routes.ts`
- **Tests**: `server/test/oidc.test.ts` (10 tests).

### SEC-08: Inconsistent Admin Role Hierarchy Enforcement
- **Vulnerability**: Subordinate admins could demote superadmins or instance owners, modify their own roles, or deactivate themselves. Instance owners were rejected from backup download endpoints.
- **Root-Cause Fix**:
  - Defined explicit `ROLE_RANK = { member: 1, admin: 2, superadmin: 3, owner: 4 }`.
  - Disallowed self-role-change and self-deactivation.
  - Forbade subordinate admins from demoting, changing, or deactivating higher-ranked roles.
  - Permitted instance owners and superadmins access to backup endpoints.
- **Files**: `server/src/auth/admin-routes.ts`, `server/src/export/routes.ts`
- **Tests**: `server/test/admin-dashboard.test.ts` (11 tests).

### SEC-09: Missing Lockout on 6-Digit Email Verification Codes
- **Vulnerability**: `POST /api/verify-email` checked 6-digit numeric codes without tracking failed attempts, allowing online brute-force attacks within the 30-minute validity window.
- **Root-Cause Fix**:
  - Added failure tracking per account (`verify:${email}`) and IP (`ip:${req.ip}`).
  - Enforced 429 Too Many Requests lockout after 5 failed attempts.
  - Added `invalidateEmailTokens(userId, 'verify_email')` automatically expiring outstanding verification tokens upon reaching 5 failures.
- **Files**: `server/src/auth/lockout.ts`, `server/src/auth/email-tokens.ts`, `server/src/auth/routes.ts`
- **Tests**: `server/test/auth.test.ts` (8 tests).

### SEC-10: Unbounded Git Clone Ingestion DoS
- **Vulnerability**: Git repository sync read all repository files into memory simultaneously without size caps, leading to V8 heap exhaustion and process crashes on large codebases.
- **Root-Cause Fix**:
  - Added `stat()` check before reading files (`MAX_FILE_BYTES = 1_048_576`).
  - Capped maximum indexed repository paths to `10_000`.
  - Expanded `IGNORED` regex to exclude `node_modules`, `dist`, `build`, `.next`, and `.turbo`.
- **Files**: `server/src/repositories/git-sync.ts`, `server/src/repositories/scheduler.ts`
- **Tests**: `server/test/repository-scheduler.test.ts` (6 tests).

### SEC-11: Unrestricted Global Shared Perspective Creation
- **Vulnerability**: Standard members could create unvaulted shared graph perspectives (`vaultId: null`, `isShared: true`) that were automatically served to all instance users.
- **Root-Cause Fix**:
  - Restricted unvaulted perspective creation and deletion to `admin`, `superadmin`, and `owner` roles across REST API and MCP tool `save_graph_perspective`.
- **Files**: `server/src/graph/routes.ts`, `server/src/mcp/server.ts`
- **Tests**: `server/test/graph-perspectives.test.ts` (7 tests).

### SEC-12: Transitive Build and CLI Dependencies
- **Vulnerability**: `pnpm audit` reported 15 vulnerability advisories in transitive packages (`undici`, `browserslist`, `js-yaml`).
- **Root-Cause Fix**:
  - Added workspace package override pins in `pnpm-workspace.yaml` for `browserslist`, `baseline-browser-mapping`, `js-yaml`, `undici`, `esbuild`, `lodash-es`, `postcss`, and `nanoid`.
- **Files**: `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- **Verification**: `pnpm audit` reports 0 vulnerabilities.
