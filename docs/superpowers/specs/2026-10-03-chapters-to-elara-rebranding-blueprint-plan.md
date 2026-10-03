# Chapters to Elara Rebranding: Blueprint Overall Plan

**Date**: 2026-10-03  
**Scope**: Definitive architectural blueprint and phased execution matrix for rebranding the entire Chapters ecosystem to **Elara**, ordered strictly from easiest/lowest-risk to hardest/most time-consuming, accompanied by zero-downtime transition protocols, backward-compatibility shims, and pre-task knowledge freshness verification.  
**Related Vault Notes**: `rebranding/blueprint-overall-plan`, `spec/2026-10-03-chapters-to-elara-rebrand-master-plan`, `user-observations/improvements-bugs-fixies`.  

---

> [!CAUTION]
> **MANDATORY APPROVAL GATE: STRICTLY ZERO CODE EXECUTION PRIOR TO FORMAL USER APPROVAL**  
> Per explicit requirements in `user-observations/improvements-bugs-fixies`:
> - **No code modifications, file renames, package changes, or database alterations** may begin until this blueprint plan has been reviewed and each section is planned and approved one by one.
> - This blueprint serves as the overarching architectural reference.

---

## 1. Rebranding Complexity & Risk Matrix (Easiest to Hardest)

The rebranding of Chapters to ***Elara*** spans the entire technology stack: user-facing visual design, agent skills, Model Context Protocol prompts, client SPA state, server runtime configuration, collaborative CRDT relays, container orchestration, and persistent PostgreSQL storage.

To guarantee **zero downtime**, **zero data loss**, and **zero broken agent workflows**, the plan is ordered in 6 sequential phases from lowest risk/effort to highest technical complexity:

```mermaid
flowchart TD
    P1["Phase 1: Brand Assets & Documentation<br/>(🟢 Very Low Risk • 1–2 hrs)"]
    P2["Phase 2: Client UI Presentation & Local Storage<br/>(🟡 Low Risk • 2–4 hrs)"]
    P3["Phase 3: Agent Skills, MCP Prompts & Slash Aliases<br/>(🟠 Moderate Risk • 4–6 hrs)"]
    P4["Phase 4: Package Names, Config & Dual Env Vars<br/>(🟠 Medium-High Risk • 6–8 hrs)"]
    P5["Phase 5: Server API, Yjs CRDT Relay, Cookies & Auth<br/>(🔴 High Risk • 1–2 days)"]
    P6["Phase 6: Database Roles, Storage Volumes & Domain DNS<br/>(🔴 Critical / Most Complex • 2–3 days)"]

    P1 --> P2 --> P3 --> P4 --> P5 --> P6

    style P1 fill:#064e3b,stroke:#10b981,color:#ffffff
    style P2 fill:#065f46,stroke:#34d399,color:#ffffff
    style P3 fill:#78350f,stroke:#f59e0b,color:#ffffff
    style P4 fill:#9a3412,stroke:#f97316,color:#ffffff
    style P5 fill:#7f1d1d,stroke:#ef4444,color:#ffffff
    style P6 fill:#450a0a,stroke:#dc2626,color:#ffffff
```

| Phase | Scope | Complexity | Risk Level | Est. Effort | Key Deliverables | Status |
| :---: | :--- | :---: | :---: | :---: | :--- | :---: |
| **Phase 1** | **Brand Assets, Public Documentation & Copy** | 🟢 Very Low | Minimal | 1–2 hrs | Elara SVG logo, favicons, `README.md`, `CLAUDE.md`, licenses, `docs/` | ⏳ Gated |
| **Phase 2** | **Client SPA Presentation & Local Storage** | 🟡 Low | Low | 2–4 hrs | HTML `<title>`, TopBar/Rail brand text, `elara_*` localStorage migration | ⏳ Gated |
| **Phase 3** | **Agent Skills, MCP Prompts & Slash Aliases** | 🟠 Moderate | Medium | 4–6 hrs | `skills/elara`, `/elara-*` slash commands + legacy `/chapters-*` aliases, 20 MCP prompts | ⏳ Gated |
| **Phase 4** | **Package Scopes, Docker & Dual-Read Env Vars** | 🟠 Moderate | Medium-High | 6–8 hrs | `@elara/client`, `@elara/server`, `ELARA_*` env vars with fallback, Dockerfiles | ⏳ Gated |
| **Phase 5** | **Server API, Yjs Relay, Session Cookies & Auth** | 🔴 High | High | 1–2 days | Dual `elara_session` / `chapters_session` cookies, JWT issuer fallback, Yjs namespace bridge | ⏳ Gated |
| **Phase 6** | **Database Roles, Volumes & Domain Migration** | 🔴 Critical | High-Critical | 2–3 days | `elara-data` volume migration, Postgres roles, `elara.piiix.org` 301 redirects | ⏳ Gated |

---

## 2. Phase-by-Phase Technical Specification & Blueprint

### Phase 1: Brand Assets, Visual Identity & Documentation (Easiest / Lowest Risk)
* **Objective**: Establish the official visual assets and external documentation for **Elara** without modifying any executable identifiers, imports, or APIs.
* **Risk & Impact**: None. Zero runtime impact.
* **Technical Breakdown**:
  1. **Visual Brand Identity**:
     - Design modern SVG and raster brand marks for **Elara** (celestial aesthetic inspired by Jupiter's moon Elara: sleek orbital typography, deep space obsidian `#0B0F17` background with interstellar emerald `#10B981` accents).
     - Generate icon set: `client/public/favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, and PWA splash icons.
  2. **Project Documentation**:
     - Update `README.md` introducing **Elara**: *"Elara — The AI-Navigable Second Brain & Knowledge Graph Platform"*.
     - Update `CLAUDE.md`, `CONTRIBUTING.md`, and architectural overviews in `docs/`.
     - Update copyright notices and repository metadata while preserving historical references as *"Elara (formerly Chapters)"*.

---

### Phase 2: Client SPA Presentation, Metadata & Local Storage (Low Complexity)
* **Objective**: Transform browser presentation and client storage keys while ensuring continuous backward compatibility for returning users.
* **Risk & Impact**: Low. Safe client-side updates verified with component test suites.
* **Technical Breakdown**:
  1. **HTML & Meta Tags**:
     - Update `client/index.html`: `<title>Elara</title>`, meta description, OpenGraph headers, application name, and web manifest.
  2. **Shell UI Components**:
     - Update Observatory Bridge shell header in `TopBar.tsx`, `Rail.tsx`, and `AppShell.tsx` to display **Elara**.
     - Update onboarding and authentication views:
       - `client/src/pages/auth/SetupPage.tsx` ("Set up Elara")
       - `client/src/pages/auth/PendingApprovalPage.tsx` ("Welcome to Elara")
       - `client/src/pages/VaultsPage.tsx` ("saved to your Elara account").
  3. **Non-Destructive LocalStorage Migration**:
     - Implement migration utility reading new keys first with transparent fallback to legacy keys:
       - `elara_vaults_view` $\leftarrow$ fallback to `chapters_vaults_view`
       - `elara_vaults_group_by_folder` $\leftarrow$ fallback to `chapters_vaults_group_by_folder`
       - `elara_notes_view_mode` $\leftarrow$ fallback to `chapters_notes_view_mode`
       - `elara_notes_group_by_folder` $\leftarrow$ fallback to `chapters_notes_group_by_folder`
       - `elara_chunk_reload` $\leftarrow$ fallback to `chapters_chunk_reload`
     - On first read, seamlessly promote stored values to the new `elara_*` keys.
  4. **Frontend Vitest Suite**:
     - Update DOM assertions in `PendingApprovalPage.test.tsx`, `AppShell.test.tsx`, `InstanceOverview.test.tsx`, and `RepositorySettingsDialog.test.tsx`.

---

### Phase 3: AI Agent Skills, MCP Engineering Prompts & Slash Aliases (Moderate Complexity)
* **Objective**: Migrate AI agent operational capabilities and MCP prompt templates to Elara while maintaining 100% interoperability with existing agent configurations.
* **Risk & Impact**: Medium. Critical for developer workflows and autonomous agent pair programming.
* **Technical Breakdown**:
  1. **Dual-Registered Slash Commands**:
     - Register the new canonical command family:
       - `/elara-status`, `/elara-search`, `/elara-symbols`, `/elara-graph`, `/elara-path`, `/elara-perspective`, `/elara-prompt`, `/elara-note`, `/elara-repo`, `/elara-vault`, `/elara-map`, `/elara-export`
     - Retain legacy `/chapters-*` commands as live aliases forwarding to the `/elara-*` implementation, ensuring existing muscle memory and scripts do not break.
  2. **Agent Skill Package (`skills/elara`)**:
     - Create `skills/elara/` containing updated `SKILL.md`, `rules/elara.md`, and protocols (`references/codebase-mapping-protocol.md`, `references/mcp-tools.md`, `references/okf-format.md`).
     - Place a backward-compatible proxy/symlink in `skills/chapters` redirecting to `skills/elara`.
     - Update `skills/elara/scripts/install-always-on.sh` supporting Google Gemini/Antigravity, Claude Desktop/Code, Cursor, and Windsurf.
  3. **MCP Engineering Prompts Suite (20 Prompts)**:
     - Update all prompt definitions in `server/src/mcp/prompts.ts`:
       - `active_project_companion`: Pair on projects using Elara as the living second brain.
       - `sync_local_docs_to_vault`: Ingest local documentation into Elara vaults.
       - `plan_feature_implementation`: Ground implementation plans in Elara specs.
       - Update remaining 17 prompts (`draft_adr`, `explain_code_architecture`, `refactor_impact_analysis`, etc.) replacing Chapters references with Elara.

---

### Phase 4: Package Names, Configuration & Dual-Read Environment Variables (Moderate to High)
* **Objective**: Rename workspace packages and establish a dual-read configuration layer allowing seamless transition between legacy and new environment configurations.
* **Risk & Impact**: Medium-High. Must prevent broken builds or missing configuration parameters.
* **Technical Breakdown**:
  1. **Workspace Package Identifiers**:
     - Root `package.json`: `"name": "elara"`
     - Client `client/package.json`: `"name": "@elara/client"`
     - Server `server/package.json`: `"name": "@elara/server"`
     - Update workspace dependencies and locks in `pnpm-workspace.yaml`.
  2. **Dual-Read Configuration Fallback Engine (`server/src/config.ts`)**:
     - Implement universal fallback pattern prioritizing `ELARA_*` while transparently reading `CHAPTERS_*` or standard system variables:
       ```typescript
       port: Number(process.env.ELARA_PORT ?? process.env.CHAPTERS_PORT ?? process.env.PORT ?? 3000),
       databaseUrl: process.env.ELARA_DATABASE_URL ?? process.env.CHAPTERS_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://elara:elara@localhost:5432/elara',
       dataDir: process.env.ELARA_DATA_DIR ?? process.env.CHAPTERS_DATA_DIR ?? process.env.DATA_DIR ?? '/data/elara',
       credentialsEncryptionKey: process.env.ELARA_CREDENTIALS_ENCRYPTION_KEY ?? process.env.CHAPTERS_CREDENTIALS_ENCRYPTION_KEY ?? process.env.CREDENTIALS_ENCRYPTION_KEY,
       smtpFrom: process.env.ELARA_SMTP_FROM ?? process.env.CHAPTERS_SMTP_FROM ?? process.env.SMTP_FROM ?? 'elara@localhost',
       backupS3Prefix: process.env.ELARA_BACKUP_S3_PREFIX ?? process.env.CHAPTERS_BACKUP_S3_PREFIX ?? process.env.BACKUP_S3_PREFIX ?? 'elara-backups/',
       ```
  3. **Docker & Container Images**:
     - Update `Dockerfile` and `docker-compose.yml`:
       - Service names: `app`, `db`
       - Image labels: `elara:latest`
       - Ensure backup zip pattern in `backup-service.ts` recognizes both `elara-backup-*.zip` and legacy `chapters-backup-*.zip`.

---

### Phase 5: Server API, Yjs CRDT Relay, Session Cookies & Auth (High Complexity)
* **Objective**: Migrate server runtime identifiers, authentication sessions, and collaborative editing rooms without logging out active users or interrupting real-time collaboration.
* **Risk & Impact**: High. Affects user authentication state and live WebSocket synchronization.
* **Technical Breakdown**:
  1. **MCP Server Protocol Negotiation (`server/src/mcp/server.ts`)**:
     - Initialize MCP server as:
       ```typescript
       const server = new McpServer({ name: 'elara', version: '0.2.0' })
       ```
     - Preserve exact tool signatures (`list_vaults`, `search`, `find_symbols`, `graph`, `create_note`, `edit_note`) for 100% wire-protocol parity.
  2. **Dual-Cookie Authentication Transition**:
     - Session cookie: `elara_session` (fallback to `chapters_session`)
     - CSRF cookie: `elara_csrf` (fallback to `chapters_csrf`)
     - Middleware reads `elara_session` first; if absent, reads `chapters_session`. When signing in or refreshing, mints the new `elara_session` cookie. Zero active users are invalidated.
  3. **JWT Issuer & MFA Validation**:
     - Mint new tokens with `iss: 'elara'`.
     - Accept both `iss: 'elara'` and `iss: 'chapters'` during token verification until existing tokens naturally expire (7-day grace window).
     - Update TOTP MFA issuer to `Elara`.
  4. **Transactional Email & Notifications**:
     - Update email subjects:
       - `Elara: verify your email`
       - `Elara: password reset`
       - `Welcome to Elara — your account is active`
     - Notification events: `Elara: <event_type>`.
  5. **Yjs WebSocket CRDT Collaboration Relay**:
     - Maintain canonical `/collab` WebSocket path.
     - Document namespace transition: support `elara:vault:<vaultId>` while maintaining an in-memory alias bridge for any client connecting on `chapters:vault:<vaultId>` or bare `vault:<vaultId>`.

---

### Phase 6: Database Persistence, Storage Volumes & Domain Migration (Hardest / Most Critical)
* **Objective**: Execute zero-data-loss storage migration, database user/role updates, and public DNS routing.
* **Risk & Impact**: Critical. Involves permanent file storage on disk, PostgreSQL schemas, and public network ingress.
* **Technical Breakdown**:
  1. **Pre-Flight Snapshot & Backup Verification**:
     - Full automated PostgreSQL dump via `pg_dump`.
     - Complete archive of the physical note storage directory (`/data/chapters`).
     - Checksum verification of all markdown notes and git repo clones.
  2. **Disk Storage Volume Migration**:
     - In `docker-compose.yml`:
       - If `chapters-data` exists and `elara-data` is created, run an automated volume migration script or mount `/data/chapters` symlinked to `/data/elara` so notes remain fully accessible with zero duplication.
       - Temporary clone directory: transition `/tmp/chapters-repo-clones` $\rightarrow$ `/tmp/elara-repo-clones`.
  3. **PostgreSQL Database Roles & Connection Strings**:
     - Create `elara` database role and assign identical privileges to existing `chapters` database.
     - Support connection via either role during transition.
  4. **Public Domain DNS & Ingress Routing**:
     - Primary Domain: `elara.piiix.org`
     - Legacy Domain: `chapters.piiix.org`
     - Ingress configuration:
       - Issue Let's Encrypt SSL certificates for `elara.piiix.org`.
       - Deploy HTTP 301 Permanent Redirect on `chapters.piiix.org/*` forwarding to `elara.piiix.org/*`.
       - Dual CORS origin acceptance in Fastify server during transition.
  5. **Internal Repository Wikilink Refactoring**:
     - Scan and refactor internal repository wikilinks: `[[repo:chapters/...]]` $\rightarrow$ `[[repo:elara/...]]` using Chapters MCP CRDT editing tools.

---

## 3. Pre-Task Knowledge Drift & Stale Note Freshness Protocol (Observation #5)

In addition to the rebrand, observation #5 in `user-observations/improvements-bugs-fixies` establishes a symmetrical, closed-loop documentation lifecycle:

```mermaid
flowchart LR
    subgraph PreTask["1. Pre-Task Protocol (Observation #5)"]
        direction TB
        A[Task Initiated] --> B[Check Repo vs Notes Freshness]
        B --> C{Notes Outdated?}
        C -- Yes --> D[Report Outdated Notes to User & Explain Why]
        D --> E[Update Notes via MCP Tools First]
        E --> F[Proceed with Coding Task]
        C -- No --> F
    end

    subgraph PostTask["2. Post-Task Protocol (Improvement #3)"]
        direction TB
        F --> G[Code Executed & Verified]
        G --> H[Evaluate Impact on Specs & Domains]
        H --> I[Update Impacted Notes / Create ADRs]
        I --> J[Confirm Updates in Final Summary]
    end
```

1. **Pre-Task Invariant**: Before writing or modifying code on an existing project, the agent inspects git commit history and recent file changes against domain specs in Elara. If drift is detected, the agent alerts the user, lists the outdated notes, updates them first, and only then proceeds with implementation.
2. **Post-Task Invariant**: Upon task completion, the agent evaluates all code changes, updating impacted concept notes, specs, or ADRs via `edit_note` or `create_note`.

---

## 4. Section-by-Section Deep Planning Queue

Per user instructions, we will now plan each section properly one by one before any code execution:

1. [ ] **Section 1**: Phase 1 Deep Plan — Brand Assets, SVG/PNG Specifications, Color Palette & Documentation Manifest
2. [ ] **Section 2**: Phase 2 Deep Plan — Client SPA Presentation, Metadata, Observatory Bridge Components & LocalStorage Shims
3. [ ] **Section 3**: Phase 3 Deep Plan — Agent Skills Architecture, Dual Slash Command Registration & 20 MCP Prompts
4. [ ] **Section 4**: Phase 4 Deep Plan — Workspace Package Scopes, Docker Orchestration & Dual-Read Env Var Matrix
5. [ ] **Section 5**: Phase 5 Deep Plan — Server API Ingress, Yjs CRDT Room Aliasing, Dual Session Cookies & JWT Verification
6. [ ] **Section 6**: Phase 6 Deep Plan — Database Migration Scripting, Volume Preservation, DNS Cutover & Wikilink Engine
