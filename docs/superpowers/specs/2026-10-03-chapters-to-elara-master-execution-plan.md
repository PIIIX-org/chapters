# Chapters → Elara: Complete Rebrand Execution Plan

> **⚠ THIS IS THE MASTER EXECUTION DOCUMENT. NO DETAIL HAS BEEN COMPRESSED.**
> Every file path, every line number, every code change, every fallback pattern,
> every rollback step is documented here. Corrupting this operation could cause
> data loss, session invalidation, split-brain CRDT conflicts, or DNS outages.

**Date**: 2026-10-03
**Vault**: `c1e3c446-d3f9-4868-9716-44b9c3234e72`
**Repository**: `github.com/PIIIX-org/chapters`

---

## Governing Invariants (Apply to ALL Phases)

> [!CAUTION]
> **These invariants are non-negotiable. Violating any one of them is a
> stop-the-line event.**

1. **ZERO COLOR / DESIGN CHANGES**: Deep space obsidian `#070A0F` / `#0B0F17`, hairline borders `var(--border)`, emerald accent `var(--primary)`, typography stacks `Geist` / `Geist Mono` — all remain 100% identical.
2. **ZERO DATA LOSS**: No vault notes, localStorage preferences, database rows, session tokens, or backup archives may be lost or orphaned at any point.
3. **ZERO FORCED LOGOUTS**: Active authenticated sessions must survive the entire deployment without interruption.
4. **ZERO CRDT SPLIT-BRAIN**: Two users editing the same note must never be partitioned into separate Yjs rooms during or after deployment.
5. **ZERO MCP WIRE BREAKS**: Claude Desktop, Cursor, and Gemini CLI connections at `POST /mcp` must continue working without client-side reconfiguration.
6. **ZERO SCHEMA MIGRATIONS**: PostgreSQL tables, foreign keys, and enums remain 100% stable with zero Drizzle drift. All 11 enums are verified brand-neutral.
7. **DOCUMENTATION PRESERVATION**: Existing docs containing "Chapters" are archived, never deleted.
8. **APPROVAL GATE**: Strictly ZERO code execution until this entire plan is formally approved.

---

## Phase Execution Order (Easiest → Hardest)

| Phase | Focus | Risk | PR |
|---|---|---|---|
| 1 | Brand Assets, Visual Identity & Documentation | 🟢 Low | [#339](https://github.com/PIIIX-org/chapters/pull/339) |
| 2 | Client SPA Presentation, Copy & LocalStorage Migration | 🟡 Medium | [#341](https://github.com/PIIIX-org/chapters/pull/341) |
| 3 | Agent Skills, MCP Engineering Prompts & Slash Aliases | 🟡 Medium | [#344](https://github.com/PIIIX-org/chapters/pull/344) |
| 4 | Workspace Package Names, Docker Orchestration & Env Vars | 🟠 High | [#348](https://github.com/PIIIX-org/chapters/pull/348) |
| 5 | Server API Ingress, Yjs CRDT Relay, Session Cookies & Auth | 🔴 Critical | [#349](https://github.com/PIIIX-org/chapters/pull/349) |
| 6 | Database Persistence, Storage Volumes & Domain DNS Cutover | 🔴 Critical | [#350](https://github.com/PIIIX-org/chapters/pull/350) |

---

---

# PHASE 1: Brand Assets, Visual Identity & Documentation

**Risk**: 🟢 Low
**PR**: [#339](https://github.com/PIIIX-org/chapters/pull/339)

## 1.1 Brand Asset Inventory & UI Usage Map

| # | Brand Asset | Current Implementation | Exact UI Location & Usage Surface | Target Implementation (`Elara`) |
|:---:|:---|:---|:---|:---|
| **1** | **Primary Shell Rail Monogram & Logo** | Monogram: `CH`<br/>Wordmark: `Chapters`<br/>Aria: `Chapters logo, toggle sidebar` | **`client/src/components/shell/Rail.tsx`** (Lines 125–137)<br/>• **Location**: The persistent top-left navigation button in the application shell.<br/>• **Collapsed state**: Displays the standalone `CH` monogram badge.<br/>• **Expanded state**: Expands to show the monogram + `Chapters` wordmark.<br/>• **Visibility**: Seen on every authenticated page across the entire app (Graphs, Vaults, Repos, Team, Settings, Editor). | Monogram: **`EL`**<br/>Wordmark: **`Elara`**<br/>Aria: `Elara logo, toggle sidebar` |
| **2** | **Authentication Door Badge & Wordmark** | Monogram: `Ch`<br/>Wordmark: `Chapters` | **`client/src/components/auth/AuthFrame.tsx`** (Lines 31–40)<br/>• **Location**: Centered header block directly above the 360px login/setup card.<br/>• **Visibility**: Every public/unauthenticated screen (`/login`, `/signup`, `/setup`, `/pending-approval`, `/reset-password`, `/verify-email`). | Monogram: **`El`**<br/>Wordmark: **`Elara`** |
| **3** | **Browser Tab & Favicon Metadata** | Title: `<title>Chapters</title>`<br/>Favicon: *None currently linked* | **`client/index.html`** (Line 7)<br/>• **Location**: Browser tab bar, bookmarks, and PWA title.<br/>• **Visibility**: All browser tabs and window headers. | Title: **`<title>Elara</title>`**<br/>Favicon: Add SVG favicon matching the exact existing typography/style. |
| **4** | **Default Root Breadcrumb** | Fallback label: `Chapters` | **`client/src/components/shell/Breadcrumb.tsx`** (Line 5)<br/>• **Location**: Top/bottom breadcrumb trails when at the root level without an active sub-path.<br/>• **Code**: `items.length > 0 ? items : [{ label: 'Chapters' }]` | Fallback label: **`Elara`** |
| **5** | **AI Collaborator Avatar & Ink Badge** | Name: `Chapters MCP`<br/>Monogram: `CM` | **`client/src/components/vault/CollaboratorAvatars.tsx`** & `penNibCursor.test.ts`<br/>• **Location**: Collaborative live editing avatar stack in the note header when an AI agent / MCP connection is streaming edits into a note. | Name: **`Elara MCP`**<br/>Monogram: **`EM`** |

## 1.2 Component-Level File Modifications

### 1.2.1 `client/src/components/shell/Rail.tsx`

**Lines 128, 135–136**:
```diff
- aria-label="Chapters logo, toggle sidebar"
+ aria-label="Elara logo, toggle sidebar"
...
- <span>CH</span>
- {expanded && <span className="font-sans text-xs font-normal text-muted-foreground">Chapters</span>}
+ <span>EL</span>
+ {expanded && <span className="font-sans text-xs font-normal text-muted-foreground">Elara</span>}
```

### 1.2.2 `client/src/components/auth/AuthFrame.tsx`

**Lines 37, 39**:
```diff
  <span
    aria-hidden="true"
    className="flex size-8 items-center justify-center rounded-[var(--radius-sm,2px)] bg-foreground font-mono text-[12px] font-semibold text-background"
  >
-   Ch
+   El
  </span>
- <span className="text-sm font-medium text-foreground tracking-tight">Chapters</span>
+ <span className="text-sm font-medium text-foreground tracking-tight">Elara</span>
```

### 1.2.3 `client/index.html`

**Lines 6–8**:
```diff
  <meta name="color-scheme" content="dark light" />
- <title>Chapters</title>
+ <title>Elara</title>
+ <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
```

### 1.2.4 `client/src/components/shell/Breadcrumb.tsx`

**Line 5**:
```diff
- const shown = items.length > 0 ? items : [{ label: 'Chapters' }]
+ const shown = items.length > 0 ? items : [{ label: 'Elara' }]
```

### 1.2.5 `client/src/components/vault/CollaboratorAvatars.tsx` & Tests

```diff
- 'Chapters MCP' (Monogram 'CM')
+ 'Elara MCP' (Monogram 'EM')
```

## 1.3 Test Suite Updates (Phase 1)

1. **`client/src/components/shell/AppShell.test.tsx`**:
   - Update role button queries checking `'Chapters logo, toggle sidebar'` → `'Elara logo, toggle sidebar'` (Lines 263, 303, 480, 500, 518, 535).
2. **`client/src/components/auth/AuthFrame.test.tsx`**:
   - Line 15: `expect(screen.getByText('Chapters')).toBeInTheDocument()` → `expect(screen.getByText('Elara')).toBeInTheDocument()`.
3. **`client/src/components/vault/CollaboratorAvatars.test.tsx`**:
   - Lines 56–67: Update assertions checking for `'Chapters MCP'` and `'CM'`.
4. **`client/src/components/vault/penNibCursor.test.ts`**:
   - Line 86: `name: 'Chapters MCP'` → `name: 'Elara MCP'`.

---

---

# PHASE 2: Client SPA Presentation, Copy & LocalStorage Migration

**Risk**: 🟡 Medium
**PR**: [#341](https://github.com/PIIIX-org/chapters/pull/341)

## 2.1 Client Copy & Heading Inventory (All 13 Components, Exact Files & Lines)

| # | Component / Page | File Location & Line | Current Copy | Target Copy (`Elara`) |
|:---:|:---|:---|:---|:---|
| **1** | **Setup Page** | `client/src/pages/auth/SetupPage.tsx:46` | `<AuthFrame eyebrow="first run" title="Set up Chapters">` | `title="Set up Elara"` |
| **2** | **Pending Approval** | `client/src/pages/auth/PendingApprovalPage.tsx:11,18` | `title="Welcome to Chapters"`<br/>`Welcome to Chapters...! Your account has been created...` | `title="Welcome to Elara"`<br/>`Welcome to Elara...! Your account has been created...` |
| **3** | **Vaults Cloud Sync Notice** | `client/src/pages/VaultsPage.tsx:907` | `...saved to your Chapters account and automatically stay in sync across your Mac, Windows laptop, and all browsers.` | `...saved to your Elara account...` |
| **4** | **Appearance Settings** | `client/src/components/settings/AppearanceSection.tsx:43` | `How Chapters looks on this device. The choice is saved in this browser only.` | `How Elara looks on this device. The choice is saved in this browser only.` |
| **5** | **MFA Authenticator Prompt** | `client/src/components/settings/MfaSection.tsx:187,238` | `Add Chapters to your authenticator app...`<br/>`...Set it up to carry on using Chapters.` | `Add Elara to your authenticator app...`<br/>`...Set it up to carry on using Elara.` |
| **6** | **Connect Repo Dialog** | `client/src/components/repositories/ConnectRepositoryDialog.tsx:35,40,105,124` | • `Chapters clones the remote...`<br/>• `Chapters indexes a folder...`<br/>• `Chapters reads code and never writes it back...`<br/>• `How should Chapters get the code?` | • `Elara clones the remote...`<br/>• `Elara indexes a folder...`<br/>• `Elara reads code and never writes it back...`<br/>• `How should Elara get the code?` |
| **7** | **Repository Settings** | `client/src/components/repositories/RepositorySettingsDialog.tsx:129,200` | • `The name is Chapters' own label...`<br/>• `...everything Chapters indexed from it...` | • `The name is Elara's own label...`<br/>• `...everything Elara indexed from it...` |
| **8** | **Repository Share List** | `client/src/components/repositories/RepositoryShareList.tsx:220` | `...because Chapters never writes code back...` | `...because Elara never writes code back...` |
| **9** | **Repository Sync Status** | `client/src/components/repositories/RepositorySyncCard.tsx:33,147,187` | • `Chapters does not read connected folders yet...`<br/>• `Chapters is indexing this repository right now.`<br/>• `...Chapters is polling this remote on a schedule...` | • `Elara does not read connected folders yet...`<br/>• `Elara is indexing this repository right now.`<br/>• `...Elara is polling this remote on a schedule...` |
| **10** | **Symbol Outline Empty State** | `client/src/components/repositories/SymbolOutline.tsx:43` | `No symbols in this file. Chapters extracts an outline only from the languages it parses...` | `...Elara extracts an outline only from the languages it parses...` |
| **11** | **Webhook Setup Card** | `client/src/components/repositories/WebhookSetupCard.tsx:83` | `No webhook yet — Chapters polls this remote on a schedule...` | `...Elara polls this remote on a schedule...` |
| **12** | **Code Viewer Invariant Tooltip** | `client/src/components/repositories/CodeViewer.tsx:164` | `title="Chapters never writes code back — git stays the record of truth."` | `title="Elara never writes code back — git stays the record of truth."` |
| **13** | **Repos / Repository Empty States** | `client/src/pages/ReposPage.tsx:511`<br/>`client/src/pages/RepositoryPage.tsx:200` | `Chapters never writes code back — git stays the record of truth.` | `Elara never writes code back — git stays the record of truth.` |

## 2.2 Non-Destructive LocalStorage Migration Specification

### Dual-Read Transparent Fallback Pattern

```
Read elara.key → exists? → use it
                  ↓ no
Read chapters.key → exists? → copy to elara.key → return value
                    ↓ no
Return default value
```

### Complete LocalStorage Key Transition Matrix (All 22 Keys)

| Subsystem | Legacy Key (`Chapters`) | Canonical Key (`Elara`) | File Location |
|:---|:---|:---|:---|
| **Shell Sidebar** | `chapters.shell.sidebar` | `elara.shell.sidebar` | `client/src/components/shell/ShellProvider.tsx` |
| **Appearance Theme** | `chapters.theme` | `elara.theme` | `client/src/lib/theme.ts` |
| **Chunk Auto-Reload** | `chapters_chunk_reload` | `elara_chunk_reload` | `client/src/main.tsx`, `client/src/router.tsx` |
| **Vaults View Mode** | `chapters_vaults_view` | `elara_vaults_view` | `client/src/pages/VaultsPage.tsx` |
| **Vaults Folders Toggle** | `chapters_vaults_group_by_folder` | `elara_vaults_group_by_folder` | `client/src/pages/VaultsPage.tsx` |
| **Notes View Mode** | `chapters_notes_view_mode` | `elara_notes_view_mode` | `client/src/pages/vault/VaultNotesPage.tsx` |
| **Notes Folders Toggle** | `chapters_notes_group_by_folder` | `elara_notes_group_by_folder` | `client/src/pages/vault/VaultNotesPage.tsx` |
| **Repos View Mode** | `chapters_repos_view_mode` | `elara_repos_view_mode` | `client/src/pages/ReposPage.tsx` |
| **Repos Folders Toggle** | `chapters_repos_group_by_folder` | `elara_repos_group_by_folder` | `client/src/pages/ReposPage.tsx` |
| **Custom Palette** | `chapters_custom_palette` | `elara_custom_palette` | `client/src/components/vault/CustomColorPickerDialog.tsx` |
| **Vault Storage Mode** | `chapters_vault_storage_mode` | `elara_vault_storage_mode` | `client/src/components/vault/useVaultFolders.ts` |
| **Vault Folders Structure** | `chapters_vault_folders` | `elara_vault_folders` | `client/src/components/vault/useVaultFolders.ts` |
| **Folder Colors** | `chapters_folder_colors` | `elara_folder_colors` | `client/src/components/vault/useVaultFolders.ts` |
| **Vault Card Colors** | `chapters_vault_colors` | `elara_vault_colors` | `client/src/components/vault/useVaultFolders.ts` |
| **Vault Favorites** | `chapters_vault_favorites` | `elara_vault_favorites` | `client/src/components/vault/useVaultFolders.ts` |
| **Note Folders (per vault)** | `chapters_note_folders_${vaultId}` | `elara_note_folders_${vaultId}` | `client/src/components/vault/useNoteFolders.ts` |
| **Note Folder Colors** | `chapters_note_folder_colors_${vaultId}` | `elara_note_folder_colors_${vaultId}` | `client/src/components/vault/useNoteFolders.ts` |
| **Note Colors** | `chapters_note_colors_${vaultId}` | `elara_note_colors_${vaultId}` | `client/src/components/vault/useNoteFolders.ts` |
| **Note Favorites** | `chapters_note_favorites_${vaultId}` | `elara_note_favorites_${vaultId}` | `client/src/components/vault/useNoteFolders.ts` |
| **Note Editor Width** | `chapters:note-width-preference` | `elara:note-width-preference` | `client/src/components/vault/note-toolbar-utils.ts` |
| **Default Text Direction** | `chapters:note-direction-default` | `elara:note-direction-default` | `client/src/components/vault/note-toolbar-utils.ts` |
| **Scoped Text Direction** | `chapters:note-direction:${id}:${p}` | `elara:note-direction:${id}:${p}` | `client/src/components/vault/note-toolbar-utils.ts` |

### Migration Helper (`client/src/lib/storage.ts`)

```typescript
export function getMigratedStorageItem(canonicalKey: string, legacyKey: string): string | null {
  const canonical = localStorage.getItem(canonicalKey)
  if (canonical !== null) return canonical

  const legacy = localStorage.getItem(legacyKey)
  if (legacy !== null) {
    localStorage.setItem(canonicalKey, legacy)
    return legacy
  }

  return null
}
```

## 2.3 Test Suite Updates (Phase 2)

1. **`client/src/pages/auth/PendingApprovalPage.test.tsx`**:
   - Update heading assertion: `expect(screen.getByRole('heading', { name: /Welcome to Elara/i })).toBeInTheDocument()`.
2. **`client/src/components/settings/MfaSection.test.tsx`**:
   - Update OTP URI fixture: `otpauth://totp/Elara:reader@example.com?secret=...&issuer=Elara`.
3. **`client/src/components/vault/useVaultFolders.test.ts`**:
   - Assert storage reads and writes target `elara_vault_folders` and `elara_vault_storage_mode`.
4. **`client/src/components/vault/CustomColorPickerDialog.test.tsx`**:
   - Assert custom palette storage key is `elara_custom_palette`.
5. **`client/src/pages/RepositoryPage.test.tsx` & `RepositorySettingsDialog.test.tsx`**:
   - Update mock repository name fixtures and headings from `'Chapters'` to `'Elara'`.

---

---

# PHASE 3: Agent Skills, MCP Engineering Prompts & Slash Aliases

**Risk**: 🟡 Medium
**PR**: [#344](https://github.com/PIIIX-org/chapters/pull/344)

## 3.1 Inventory (9 Files, 177 References)

| # | Subsystem Component | File Location | References | Current → Target |
|:---:|:---|:---|:---:|:---|
| **1** | Skill Definition | `skills/chapters/SKILL.md` | 79 | `skills/elara/SKILL.md` (with `skills/chapters/` proxy) |
| **2** | MCP Prompts Suite | `server/src/mcp/prompts.ts` | 25 | 20 prompt templates → Elara second brain |
| **3** | Agent Rule Protocol | `skills/chapters/rules/chapters.md` | 8 | `skills/elara/rules/elara.md` |
| **4** | Mapping Protocol | `skills/.../codebase-mapping-protocol.md` | 16 | References → Elara vaults & repo links |
| **5** | OKF Format Guide | `skills/.../okf-format.md` | 29 | Updated notes and schema references |
| **6** | MCP Tools Spec | `skills/.../mcp-tools.md` | 6 | 57 Elara MCP tools reference |
| **7** | Always-On Installer | `skills/.../install-always-on.sh` | 13 | Multi-platform installer for Elara |
| **8** | Prompts Test Suite | `server/test/mcp-prompts.test.ts` | 8 | Assert Elara prompt contents |
| **9** | MCP Server Identity | `server/src/mcp/server.ts` | 1 | `name: 'elara'` |

## 3.2 Slash Command Dual-Registration Architecture

Canonical `/elara-*` handlers with `/chapters-*` as permanent forwarding aliases:

| Canonical Command (`Elara`) | Backward-Compatible Alias | Backing MCP Tool(s) | Description |
|:---|:---|:---|:---|
| **`/elara-status`** | `/chapters-status` | `list_vaults`, `list_repositories`, `list_notifications` | Check connection, active vaults, and connected repos |
| **`/elara-search`** | `/chapters-search` | `search` | Hybrid lexical + vector semantic search |
| **`/elara-symbols`** | `/chapters-symbols` | `find_symbols` | AST code symbol declaration search across repositories |
| **`/elara-graph`** | `/chapters-graph` | `graph` | Traversal, backlinks, and Louvain community clusters |
| **`/elara-path`** | `/chapters-path` | `find_graph_path` | Shortest conceptual path between notes/code |
| **`/elara-perspective`** | `/chapters-perspective` | `list/save/delete_graph_perspective` | Filter presets and scoped graph perspectives |
| **`/elara-prompt`** | `/chapters-prompt` | MCP Prompts Engine | Hydrate one of the 20 first-class prompts |
| **`/elara-note`** | `/chapters-note` | `read/create/edit/rename/delete_note` | CRUD & revision history operations on notes |
| **`/elara-repo`** | `/chapters-repo` | `browse/read_file/sync/status` | Codebase explorer and sync control |
| **`/elara-vault`** | `/chapters-vault` | `list/browse/create_vault` | Vault structure and merged-graph preferences |
| **`/elara-map`** | `/chapters-map` | 5-Phase OKF Mapping Protocol | Map codebase into interconnected OKF bundle |
| **`/elara-export`** | `/chapters-export` | `export_vault`, `export_note` | Export vault zip archive or single note markdown |

## 3.3 MCP Engineering Prompts Suite (All 20 Prompts)

All 20 prompts in `server/src/mcp/prompts.ts` updated to anchor agents to **Elara**:

1. **`active_project_companion`**: *"...using Elara as the project's living second brain."* / *"IMMEDIATELY record them in Elara notes."*
2. **`sync_local_docs_to_vault`**: *"call Elara MCP create_note or edit_note"*
3. **`plan_feature_implementation`**: *"RELEVANT SPECIFICATIONS IN ELARA"* / *"documentation notes in Elara should be updated"*
4. **`draft_adr`**: `author: Elara Agent`
5. **`explain_code_architecture`**: Traces code back to ADRs in Elara
6. **`onboard_subsystem`**: Generates onboarding guide grounded in Elara knowledge graph
7. **`summarize_concept_chain`**: Uses `find_graph_path` to connect concepts in Elara
8. **`audit_architecture_drift`**: Compares Elara specs against live code AST
9. **`refactor_impact_analysis`**: Blast radius using Elara graph
10. **`audit_orphaned_code`**: Dark matter lacking documentation in Elara
11. **`test_gap_analysis`**: Audits core domain notes in Elara against test suites
12. **`pr_review_against_specs`**: *"What notes in Elara need to be updated before this PR merges?"*
13. **`generate_release_notes`**: From recent Elara notes, ADRs, and git commits
14. **`audit_security_surface`**: Ingress routes and trust boundaries in Elara graph
15. **`database_schema_evolution`**: Against Elara data model notes
16. **`supernode_bottleneck_audit`**: Graph centrality in Elara
17. **`incident_postmortem`**: Post-mortem notes stored in Elara
18. **`generate_api_spec`**: From code entrypoints
19. **`prepare_task_context`**: Bundles relevant Elara notes and graph context
20. **`draft_rfc`**: Generates RFC with rollout plans in Elara

## 3.4 Multi-Platform Installer Migration (`install-always-on.sh`)

- **Google Gemini / Antigravity**: Installs `~/.gemini/config/rules/elara.md` (removes deprecated `chapters.md`)
- **Anthropic Claude**: Appends Elara Always-Active Protocol to `~/.claude/CLAUDE.md`
- **Cursor**: Creates `.cursor/rules/elara.mdc` (`alwaysApply: true`)
- **Windsurf**: Appends Elara Always-Active Protocol to `.windsurfrules`

## 3.5 Test Suite Updates (Phase 3)

1. **`server/test/mcp-prompts.test.ts`**: Verify 20 prompt registrations, content contains "Elara", token budget compliance.
2. **Backward-Compatibility**: Test both `/elara-search` and `/chapters-search` for transparent routing.

---

---

# PHASE 4: Workspace Package Names, Docker Orchestration & Dual-Read Env Vars

**Risk**: 🟠 High
**PR**: [#348](https://github.com/PIIIX-org/chapters/pull/348)

## 4.1 Inventory (8 Files, 32 References)

| # | Component / Subsystem | File Location & Lines | Current State (`Chapters`) | Target State (`Elara`) |
|:---:|:---|:---|:---|:---|
| **1** | Root Package | `package.json:2` | `"name": "chapters"` | `"name": "elara"` |
| **2** | Client Workspace Package | `client/package.json:2` | `"name": "@chapters/client"` | `"name": "@elara/client"` |
| **3** | Server Workspace Package | `server/package.json:2` | `"name": "@chapters/server"` | `"name": "@elara/server"` |
| **4** | Dockerfile | `Dockerfile:23,28,52,60,77,78` | `@chapters/client`, `@chapters/server`, `/data/chapters`, `DATA_DIR=/data/chapters` | `@elara/client`, `@elara/server`, `/data/elara` (symlinked), `DATA_DIR=/data/elara` |
| **5** | Docker Compose | `docker-compose.yml:24,70,72,102,127` | `chapters-data` volume, `POSTGRES_USER: chapters`, `DATA_DIR=/data/chapters` | `elara-data` volume (with symlink fallback), `POSTGRES_USER: elara`, `DATA_DIR=/data/elara` |
| **6** | Server Configuration Engine | `server/src/config.ts:20,46,83` | Fallbacks to `chapters` database | Universal dual-read `ELARA_*` ← `CHAPTERS_*` fallback engine |
| **7** | Temporary Clone Directory | `server/src/repositories/git-sync.ts:54` | `join(tmpdir(), 'chapters-repo-clones', ...)` | `join(tmpdir(), 'elara-repo-clones', ...)` |
| **8** | Backup Service & Export Names | `server/src/export/backup-service.ts:79,128` + `server/src/export/routes.ts:224,236` | `chapters-backup-*.zip`, `chapters-account-export.zip` | `elara-backup-*.zip` (supports both on restore), `elara-account-export.zip` |
| **9** | CI/CD Workflows | `.github/workflows/ci.yml`, `okf-sync.yml`, `publish.yml` | `POSTGRES_USER: chapters`, `--filter @chapters/server`, `ghcr.io/piiix-org/chapters` | `POSTGRES_USER: elara`, `--filter @elara/server`, `ghcr.io/piiix-org/elara` |

## 4.2 Universal Dual-Read Environment Variable Engine (`server/src/config.ts`)

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
    ? (env.ELARA_CORS_ORIGIN ?? env.CHAPTERS_CORS_ORIGIN ?? env.CORS_ORIGIN)!
        .split(',').map((o) => o.trim())
    : [],
  backup: {
    get s3Prefix() {
      return env.ELARA_BACKUP_S3_PREFIX ?? env.CHAPTERS_BACKUP_S3_PREFIX
        ?? env.BACKUP_S3_PREFIX ?? 'elara-backups/'
    },
  },
}
```

## 4.3 Docker & Disk Volume Preservation

### 4.3.1 Dockerfile Symlink Bridge

```dockerfile
RUN mkdir -p /app /data/elara \
 && ln -s /data/elara /data/chapters \
 && chown -R node:node /app /data
```

Any legacy path referencing `/data/chapters` resolves transparently to `/data/elara`.

```dockerfile
ENV DATA_DIR=/data/elara
ENV LOCAL_REPOS_ROOT=/data/elara/local-repos
```

### 4.3.2 Docker Compose Volume

Primary volume named `elara-data` mounted to `/data`. Existing instances migration:

**Option A — Volume alias (zero-downtime, recommended)**:
```yaml
volumes:
  elara-data:
    name: chapters-data   # reuse existing volume under new alias
```

**Option B — Copy and cutover**:
```bash
docker compose down
docker volume create elara-data
docker run --rm \
  -v chapters-data:/from -v elara-data:/to \
  alpine sh -c 'cp -a /from/. /to/'
docker compose up -d
```

## 4.4 Backup Service Backward Compatibility

- **Generation**: `elara-backup-${timestamp}.zip`
- **Pruning**: Dual-pattern recognizes both:
  ```typescript
  .filter((name) => /^(?:elara|chapters)-backup-.*\.zip$/.test(name))
  ```
- **Restore**: `restore-backup.ts` reads `account-dump.json` from zip — brand-neutral, works with either prefix.

---

---

# PHASE 5: Server API Ingress, Yjs CRDT Relay, Session Cookies & Auth

**Risk**: 🔴 Critical
**PR**: [#349](https://github.com/PIIIX-org/chapters/pull/349)

## 5.1 Critical Architectural Realities (Multi-Agent Audit Findings)

1. **Stateful Database Sessions (NOT Stateless JWTs)**:
   - Sessions are 32-byte cryptographic random hex, stored as SHA-256 hashes in PostgreSQL `sessions` table.
   - Session cookie is `sid` (`HttpOnly: true`, `SameSite: 'lax'`, `Secure: isProd`, `Max-Age: 30 days`).
   - JWTs are used **only** for external OIDC token verification via `jose.jwtVerify`.

2. **Yjs Room Scoping is Already Brand-Neutral**:
   - Document names: `${vaultId}/${path}` (`client/src/api/collab.ts:38`).
   - **No brand prefix** in room names. Zero risk of CRDT split-brain.

3. **MCP Wire Protocol Independence**:
   - `serverInfo.name` is purely metadata for client UI display.
   - Tool names over the wire (`search`, `read_note`, `create_note`, `find_symbols`) are unprefixed.
   - Bearer tokens are unprefixed. Renaming to `'elara'` will NOT break active MCP clients.

4. **PostgreSQL Enums & Schema Stability**:
   - None of the 11 enums contain "chapters".
   - `actor_type` (`'user' | 'mcp' | 'collab'`) is execution classification, not brand.
   - All FKs are UUIDs. **Zero schema migrations required.**

## 5.2 Dual-Cookie Session Management Architecture

### 5.2.1 Fastify Ingress Hook (`server/src/auth/plugin.ts`)

```typescript
export const SESSION_COOKIE = 'elara_session'
export const LEGACY_SESSION_COOKIES = ['chapters_session', 'sid'] as const

app.addHook('onRequest', async (req) => {
  let token = req.cookies[SESSION_COOKIE]
  let isLegacy = false

  if (!token) {
    for (const legacyName of LEGACY_SESSION_COOKIES) {
      if (req.cookies[legacyName]) {
        token = req.cookies[legacyName]
        isLegacy = true
        break
      }
    }
  }

  if (token) {
    req.sessionToken = token
    req.user = await getSessionUser(token)
    if (req.user && isLegacy) {
      req.needsSessionCookieUpgrade = true
    }
  }
})
```

### 5.2.2 Rolling Upgrade via `onSend` Hook

When a user makes any authenticated request with a legacy cookie, the server automatically attaches the new `elara_session` cookie. Session is never interrupted.

### 5.2.3 Comprehensive Invalidation on Logout (`server/src/auth/routes.ts`)

```typescript
app.post('/logout', { preHandler: app.requireAuth }, async (req, reply) => {
  if (req.sessionToken) await destroySession(req.sessionToken)
  return reply
    .clearCookie('elara_session', { path: '/' })
    .clearCookie('chapters_session', { path: '/' })
    .clearCookie('sid', { path: '/' })
    .send({ status: 'logged_out' })
})
```

## 5.3 Real-Time Collaboration (Yjs / Hocuspocus) Transition

### 5.3.1 WebSocket Ingress Path Compatibility

- **Canonical Route**: `COLLAB_PATH = '/collab'` — unchanged.
- Register `/elara-collab` as an allowed upgrade route:
  ```typescript
  const ALLOWED_UPGRADES = new Set(['/collab', '/elara-collab'])
  ```
- Protect both in `static.ts`:
  ```typescript
  RESERVED = ['/api', '/collab', '/elara-collab', '/mcp', '/repositories']
  ```

### 5.3.2 Split-Brain Prevention Invariant

> [!CAUTION]
> **Document names remain strictly `${vaultId}/${path}`.** If room names were
> rebranded to `elara:${vaultId}/${path}`, clients on different builds would
> edit separate in-memory documents, causing catastrophic file clobbering.

### 5.3.3 Client Reconnection Resilience (`client/src/hooks/useCollabDoc.ts`)

- Differentiate 403 (true access revocation) from transient rollout reconnect failures.
- 3-attempt reconnect budget with jitter before declaring `revoked`.

## 5.4 MCP Server Identity & Ingress Negotiation

```typescript
// server/src/mcp/server.ts L71
const server = new McpServer({ name: 'elara', version: '0.2.0' })
```

**Dual Ingress Endpoints** (`server/src/mcp/routes.ts`):
- Maintain `POST /mcp` permanently.
- Register `POST /elara/mcp` as an alias.
- Existing client configurations pointing to `/mcp` continue working.

## 5.5 Transactional Emails & Notifications

### 5.5.1 Email Subjects

| File | Line | Current | Target |
|---|---|---|---|
| `server/src/email/welcome.ts` | L13 | `'Welcome to Chapters — your account is active'` | `'Welcome to Elara — your account is active'` |
| `server/src/email/welcome.ts` | L15 | `'Your Chapters account has been approved...'` | `'Your Elara account has been approved...'` |
| `server/src/email/welcome.ts` | L17 | `'Chapters is a second brain you own...'` | `'Elara is a second brain you own...'` |
| `server/src/email/welcome.ts` | L49 | `'...you created a Chapters account...'` | `'...you created an Elara account...'` |
| `server/src/auth/routes.ts` | L125 | `'Chapters: verify your email'` | `'Elara: verify your email'` |
| `server/src/auth/routes.ts` | L281 | `'Chapters: password reset'` | `'Elara: password reset'` |
| `server/src/notifications/notify.ts` | L33 | `` `Chapters: ${type}` `` | `` `Elara: ${type}` `` |
| `server/src/auth/admin-routes.ts` | L212 | `'Your Chapters account has been deactivated by an admin.'` | `'Your Elara account has been deactivated by an admin.'` |
| `server/src/auth/admin-routes.ts` | L233 | `'Your Chapters account has been reactivated by an admin. You can now log in.'` | `'Your Elara account has been reactivated by an admin. You can now log in.'` |

### 5.5.2 TOTP Issuer

```typescript
// server/src/auth/mfa.ts L12
issuer: 'Elara',
```

> **⚠ SAFE**: Under RFC 6238, TOTP computation uses only the secret key and timestamp.
> Changing the issuer affects only the authenticator app label ("Elara:user@example.com"
> instead of "Chapters:user@example.com"). Existing enrolled users continue generating
> valid codes. No forced re-enrollment.

### 5.5.3 Startup Banners

```typescript
// server/src/index.ts L23
console.log(`\n=== Elara one-time setup token: ${setupToken} ===\n`)

// server/src/index.ts L61
console.log(`Elara server listening on :${config.port} (collab on ${COLLAB_PATH})`)
```

### 5.5.4 Notification Backfill SQL (Non-Blocking, Post-Deployment)

```sql
UPDATE notifications
SET message = REPLACE(message, 'Chapters', 'Elara')
WHERE message LIKE '%Chapters%';
```

## 5.6 Test Suite Updates (Phase 5)

1. **Session Continuity Test**: Inject legacy `sid` cookie → verify auth succeeds + `elara_session` Set-Cookie.
2. **Logout Multi-Purge Test**: Call `/api/logout` → verify all 3 cookies cleared.
3. **CRDT Live Co-Editing Test**: Two browser tabs on same note → verify convergence over `/collab`.
4. **MCP Wire Compatibility Test**: POST MCP `initialize` to `/mcp` → verify `serverInfo: { name: 'elara' }` + successful tool calls.
5. **MFA Continuity Test**: Verify existing TOTP seeds generate valid codes.

---

---

# PHASE 6: Database Persistence, Storage Volumes & Domain DNS Cutover

**Risk**: 🔴 Critical
**PR**: [#350](https://github.com/PIIIX-org/chapters/pull/350)

## 6.1 Database Credentials — Exhaustive Inventory

| Location | Current Value | Line |
|---|---|---|
| `server/src/config.ts` | `'postgres://chapters:chapters@localhost:5432/chapters'` | L20 |
| `server/.env.example` | `DATABASE_URL=postgres://chapters:chapters@localhost:5432/chapters` | L23 |
| `server/.env.example` | `POSTGRES_USER=chapters`, `POSTGRES_PASSWORD=chapters`, `POSTGRES_DB=chapters` | L97–99 |
| `server/.env.example` | `SMTP_FROM=chapters@localhost` | L52 |
| `docker-compose.yml` | `DATABASE_URL=postgres://${POSTGRES_USER:-chapters}:${POSTGRES_PASSWORD:-chapters}@db:5432/${POSTGRES_DB:-chapters}` | L70 |
| `docker-compose.yml` | `POSTGRES_USER: ${POSTGRES_USER:-chapters}`, PASSWORD, DB | L107–109 |
| `docker-compose.yml` | `pg_isready -U ${POSTGRES_USER:-chapters}` | L120 |
| `.github/workflows/ci.yml` | `POSTGRES_USER: chapters`, `POSTGRES_PASSWORD: chapters`, `POSTGRES_DB: chapters`, `pg_isready -U chapters` | L19–25 |

### Schema Enums — Verified Brand-Neutral

All 11 PostgreSQL enums: `user_status`, `user_role`, `team_role`, `grantee_type`, `permission`, `mcp_scope`, `email_token_purpose`, `actor_type`, `semantic_node_type`, `repository_ingestion_method`, `repository_sync_status`.

**None contain "chapters". Zero database migrations required.**

Only 3 lines in `schema.ts` mention "Chapters" — all JSDoc comments (L460, L534, L536).

### 6.1.1 `config.ts` Dual-Read Fallback

```typescript
databaseUrl:
  env.ELARA_DATABASE_URL
  ?? env.CHAPTERS_DATABASE_URL
  ?? env.DATABASE_URL
  ?? 'postgres://chapters:chapters@localhost:5432/chapters',
```

> [!CAUTION]
> The hardcoded default `postgres://chapters:chapters@localhost:5432/chapters`
> **MUST remain** as the final fallback. Production containers initialized with
> `POSTGRES_USER=chapters` will crash on `password authentication failed` if
> this default changes without the dual-read chain.

### 6.1.2 Docker Compose Defaults

```yaml
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

> **⚠ CRITICAL**: Changing defaults only affects NEW installations. Existing
> deployments have volumes initialized with user `chapters`. Operators must
> keep `POSTGRES_USER=chapters` in `.env` OR create a new role + database.

### 6.1.3 CI Workflow

```yaml
services:
  db:
    env:
      POSTGRES_USER: elara
      POSTGRES_PASSWORD: elara
      POSTGRES_DB: elara
    options: >-
      --health-cmd "pg_isready -U elara"
```

CI creates fresh containers per run — no persistence concern.

### 6.1.4 `.env.example` Updates

```env
DATABASE_URL=postgres://elara:elara@localhost:5432/elara
POSTGRES_USER=elara
POSTGRES_PASSWORD=elara
POSTGRES_DB=elara
SMTP_FROM=elara@localhost
```

### 6.1.5 Operator Migration Runbook (Optional)

```sql
CREATE ROLE elara WITH LOGIN PASSWORD 'new_secure_password';
ALTER DATABASE chapters RENAME TO elara;
ALTER DATABASE elara OWNER TO elara;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO elara;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO elara;
-- Then update .env: ELARA_DATABASE_URL=postgres://elara:new_secure_password@db:5432/elara
```

## 6.2 Physical Disk Storage — Exhaustive Inventory

| Location | Current Value | Line |
|---|---|---|
| `docker-compose.yml` | `DATA_DIR=/data/chapters` | L72 |
| `docker-compose.yml` | `LOCAL_REPOS_ROOT=/data/chapters/local-repos` | L73 |
| `docker-compose.yml` | `chapters-data:/data` (volume mount) | L102 |
| `docker-compose.yml` | `chapters-data:` (named volume declaration) | L127 |
| `Dockerfile` | `mkdir -p /app /data/chapters` | L52 |
| `Dockerfile` | `ENV DATA_DIR=/data/chapters` | L77 |
| `Dockerfile` | `ENV LOCAL_REPOS_ROOT=/data/chapters/local-repos` | L78 |
| `server/.env.example` | `DATA_DIR=/data/chapters`, `LOCAL_REPOS_ROOT=/data/chapters/local-repos` | L36–37 |
| `server/src/repositories/git-sync.ts` | `join(tmpdir(), 'chapters-repo-clones', ...)` | L54 |

### How Notes Are Stored

`server/src/notes/store.ts` L68–78: paths are `${DATA_DIR}/vaults/${uuid}/${type}/${name}.md`. Entirely UUID-based — no brand name in note file paths. Only `DATA_DIR` contains the brand.

## 6.3 Backup & Disaster Recovery — Exhaustive Inventory

| Location | Current Value | Line |
|---|---|---|
| `server/src/config.ts` | `'chapters-backups/'` (S3 prefix default) | L83 |
| `server/src/export/backup-service.ts` | `/^chapters-backup-.*\.zip$/` (local prune regex) | L79 |
| `server/src/export/backup-service.ts` | `` `chapters-backup-${timestamp}.zip` `` (filename) | L128 |
| `server/src/export/routes.ts` | `"chapters-account-export.zip"` (Content-Disposition) | L224 |
| `server/src/export/routes.ts` | `"chapters-backup.zip"` (Content-Disposition) | L236 |
| `server/test/backup-service.test.ts` | 17 references to `chapters-backup-*` and `chapters-backups/` | Multiple |

### Pre-Flight Snapshot Protocol

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

## 6.4 Domain DNS & SSL Cutover

### Current State

- **Public domain**: `chapters.piiix.org`
- **APP_URL**: Set via environment; used by OIDC callbacks, email verification links, password reset links.
- **CORS**: Configured via `CORS_ORIGIN` in `server/src/config.ts` L50.
- **Webhook URLs**: GitHub/GitLab webhooks POST to `https://chapters.piiix.org/api/repositories/:id/webhook`.
- **OIDC redirect URI**: `${APP_URL}/auth/callback` (assembled in `oidc-routes.ts` L48–56).

### DNS & SSL Transition

1. Create DNS A record: `elara.piiix.org` → same IP/load balancer.
2. Issue SSL certificate for `elara.piiix.org`.
3. Dual-domain window: Both domains resolve for **minimum 30 days**.
4. After grace period: `chapters.piiix.org` → HTTP 301 Permanent Redirect to `elara.piiix.org/*`.

### Application URL

```env
APP_URL=https://elara.piiix.org
```

### CORS — Dual-Origin During Transition

```env
# During transition:
CORS_ORIGIN=https://elara.piiix.org,https://chapters.piiix.org

# After 301 redirect confirmed:
CORS_ORIGIN=https://elara.piiix.org
```

### OIDC Redirect URI

Register `https://elara.piiix.org/auth/callback` in identity provider. Keep `https://chapters.piiix.org/auth/callback` during transition.

### Webhook URL Updates

GitHub follows 301 redirects — transparent during dual-domain window. GitLab webhooks may require manual update per-repository.

### Nginx/Cloudflare Redirect

```nginx
server {
    listen 443 ssl;
    server_name chapters.piiix.org;
    return 301 https://elara.piiix.org$request_uri;
}
```

## 6.5 CI/CD & Container Registry

| Location | Current Value | Line |
|---|---|---|
| `.github/workflows/publish.yml` | `ghcr.io/piiix-org/chapters` | L42 |
| `.github/workflows/publish.yml` | Comments referencing `chapters-cloud` | L1–2 |

### Transition

1. Publish to BOTH `ghcr.io/piiix-org/chapters` AND `ghcr.io/piiix-org/elara` (multi-tag).
2. Update `chapters-cloud` provisioner to pull from `elara`.
3. Deprecate `chapters` image tag after all customers migrated.

## 6.6 Source Code Comments & JSDoc (Zero Runtime Risk)

| File | Lines | Content |
|---|---|---|
| `server/src/db/schema.ts` | L460, L534, L536 | JSDoc: "connected to Chapters", "never authored in Chapters" |
| `server/src/repositories/permissions.ts` | L64 | Comment: `chapters:ghp_token@github.com` |
| `docker-compose.yml` | L1, L24, etc. | Header comments |
| `Dockerfile` | L65, L74, etc. | Inline comments |
| `server/.env.example` | L35, etc. | Inline comments |

Bulk find-and-replace in comments only, with manual review.

---

---

# COMPLETE FILE MANIFEST (ALL PHASES)

## Phase 1 Files (5 source + 4 test)

| File | Changes |
|---|---|
| `client/src/components/shell/Rail.tsx` | Monogram `CH` → `EL`, wordmark, aria-label |
| `client/src/components/auth/AuthFrame.tsx` | Monogram `Ch` → `El`, wordmark |
| `client/index.html` | `<title>Elara</title>`, favicon link |
| `client/src/components/shell/Breadcrumb.tsx` | Fallback label |
| `client/src/components/vault/CollaboratorAvatars.tsx` | `Chapters MCP` → `Elara MCP` |
| `client/src/components/shell/AppShell.test.tsx` | 6 aria-label assertions |
| `client/src/components/auth/AuthFrame.test.tsx` | Text assertion |
| `client/src/components/vault/CollaboratorAvatars.test.tsx` | Name/monogram assertions |
| `client/src/components/vault/penNibCursor.test.ts` | MCP name fixture |

## Phase 2 Files (13 source + 5 test + 1 new utility)

| File | Changes |
|---|---|
| `client/src/pages/auth/SetupPage.tsx` | "Set up Chapters" → "Set up Elara" |
| `client/src/pages/auth/PendingApprovalPage.tsx` | Welcome title and body |
| `client/src/pages/VaultsPage.tsx` | Cloud sync notice + localStorage keys |
| `client/src/components/settings/AppearanceSection.tsx` | Description copy |
| `client/src/components/settings/MfaSection.tsx` | Authenticator prompts (2 lines) |
| `client/src/components/repositories/ConnectRepositoryDialog.tsx` | 4 copy lines |
| `client/src/components/repositories/RepositorySettingsDialog.tsx` | 2 copy lines |
| `client/src/components/repositories/RepositoryShareList.tsx` | 1 copy line |
| `client/src/components/repositories/RepositorySyncCard.tsx` | 3 copy lines |
| `client/src/components/repositories/SymbolOutline.tsx` | 1 copy line |
| `client/src/components/repositories/WebhookSetupCard.tsx` | 1 copy line |
| `client/src/components/repositories/CodeViewer.tsx` | Tooltip title |
| `client/src/pages/ReposPage.tsx` + `RepositoryPage.tsx` | Empty state copy |
| `client/src/lib/storage.ts` | **NEW** — `getMigratedStorageItem()` helper |
| `client/src/components/shell/ShellProvider.tsx` | localStorage key |
| `client/src/lib/theme.ts` | localStorage key |
| `client/src/main.tsx` + `client/src/router.tsx` | chunk reload key |
| `client/src/pages/vault/VaultNotesPage.tsx` | 2 localStorage keys |
| `client/src/components/vault/CustomColorPickerDialog.tsx` | localStorage key |
| `client/src/components/vault/useVaultFolders.ts` | 5 localStorage keys |
| `client/src/components/vault/useNoteFolders.ts` | 4 localStorage keys (per-vault) |
| `client/src/components/vault/note-toolbar-utils.ts` | 3 localStorage keys |
| + 5 test files | Assertions updated |

## Phase 3 Files (9 source + 1 test)

| File | Changes |
|---|---|
| `skills/chapters/SKILL.md` → `skills/elara/SKILL.md` | 79 references + proxy at old path |
| `skills/chapters/rules/chapters.md` → `skills/elara/rules/elara.md` | 8 references |
| `skills/.../codebase-mapping-protocol.md` | 16 references |
| `skills/.../okf-format.md` | 29 references |
| `skills/.../mcp-tools.md` | 6 references |
| `skills/.../install-always-on.sh` | 13 references, 4 platform targets |
| `server/src/mcp/prompts.ts` | 25 references across 20 prompts |
| `server/src/mcp/server.ts` | McpServer name |
| `server/test/mcp-prompts.test.ts` | 8 assertion updates |

## Phase 4 Files (9 source + CI)

| File | Changes |
|---|---|
| `package.json` | `"chapters"` → `"elara"` |
| `client/package.json` | `"@chapters/client"` → `"@elara/client"` |
| `server/package.json` | `"@chapters/server"` → `"@elara/server"` |
| `Dockerfile` | 6 lines: filters, paths, symlink, ENV |
| `docker-compose.yml` | ~15 lines: volume, env defaults, comments |
| `server/src/config.ts` | Dual-read fallback engine |
| `server/src/repositories/git-sync.ts` | Temp dir name |
| `server/src/export/backup-service.ts` | Filename, prune regex |
| `server/src/export/routes.ts` | Content-Disposition headers |
| `.github/workflows/ci.yml` | 4 lines: Postgres env |
| `.github/workflows/publish.yml` | 3 lines: image name, comments |
| `.github/workflows/okf-sync.yml` | Filter flag |

## Phase 5 Files (10 source + session tests)

| File | Changes |
|---|---|
| `server/src/auth/plugin.ts` | `SESSION_COOKIE = 'elara_session'`, `LEGACY_SESSION_COOKIES`, dual-read hook |
| `server/src/auth/routes.ts` | Email subjects (2 lines), logout triple-clear |
| `server/src/auth/admin-routes.ts` | Notification messages (2 lines) |
| `server/src/auth/mfa.ts` | TOTP `issuer: 'Elara'` |
| `server/src/notifications/notify.ts` | Fallback email subject |
| `server/src/email/welcome.ts` | Welcome email (4 lines) |
| `server/src/index.ts` | Startup banners (2 lines) |
| `server/src/mcp/server.ts` | McpServer name + version |
| `server/src/mcp/routes.ts` | Dual ingress: `/mcp` + `/elara/mcp` |
| `server/src/sync/routes.ts` | ALLOWED_UPGRADES set |
| `server/src/static.ts` | RESERVED paths |
| `client/src/hooks/useCollabDoc.ts` | 3-attempt reconnect budget |

## Phase 6 Files (20 files, ~80 line-level changes)

| File | Changes |
|---|---|
| `server/src/config.ts` | Dual-read DATABASE_URL, SMTP_FROM default, S3 prefix |
| `server/src/db/schema.ts` | JSDoc comments (3 lines) |
| `server/src/index.ts` | Startup banner (2 lines) |
| `server/src/mcp/server.ts` | McpServer name |
| `server/src/auth/mfa.ts` | TOTP issuer |
| `server/src/auth/routes.ts` | Email subjects |
| `server/src/auth/admin-routes.ts` | Notification messages |
| `server/src/notifications/notify.ts` | Fallback subject |
| `server/src/email/welcome.ts` | Welcome email |
| `server/src/export/backup-service.ts` | Filename, prune regex |
| `server/src/export/routes.ts` | Content-Disposition |
| `server/src/repositories/git-sync.ts` | Temp directory |
| `server/src/repositories/permissions.ts` | Comment |
| `server/test/backup-service.test.ts` | 17 test fixture lines |
| `docker-compose.yml` | Volume, env defaults, comments |
| `Dockerfile` | Paths, symlink, ENV, filters, comments |
| `server/.env.example` | All defaults and comments |
| `.github/workflows/ci.yml` | Postgres env |
| `.github/workflows/publish.yml` | Image name, comments |

---

---

# GLOBAL EXECUTION ORDER

> [!CAUTION]
> Execute in this exact sequence. Each step depends on the previous one.
> Do NOT skip steps. Do NOT parallelize across phases.

```
STEP  1: Pre-flight snapshot (pg_dump + tar of /data volume)
STEP  2: DNS — create elara.piiix.org A record pointing to same IP
STEP  3: SSL — issue certificate for elara.piiix.org
STEP  4: Phase 1 — Brand assets (Rail, AuthFrame, index.html, Breadcrumb, CollaboratorAvatars)
STEP  5: Phase 1 — Run: pnpm typecheck && pnpm lint && pnpm test
STEP  6: Phase 2 — Client copy (13 components) + localStorage migration helper
STEP  7: Phase 2 — Run: pnpm typecheck && pnpm lint && pnpm test
STEP  8: Phase 3 — Skills directory rename, 20 MCP prompts, slash aliases, installer
STEP  9: Phase 3 — Run: pnpm typecheck && pnpm lint && pnpm test
STEP 10: Phase 4 — Package names, Dockerfile, docker-compose, config.ts dual-read, git-sync
STEP 11: Phase 4 — Run: pnpm typecheck && pnpm lint && pnpm test && docker build .
STEP 12: Phase 5 — Session cookie (elara_session), dual-cookie hook, logout triple-clear,
                    CRDT upgrade paths, MCP dual ingress, email subjects, welcome email
STEP 13: Phase 5 — Run: pnpm typecheck && pnpm lint && pnpm test
STEP 14: Phase 6 — Database defaults, .env.example, CI workflow, backup filenames,
                    Content-Disposition headers, JSDoc comments
STEP 15: Phase 6 — Run: pnpm typecheck && pnpm lint && pnpm test && docker build .
STEP 16: DEPLOY — Push all changes to prod branch
STEP 17: Set APP_URL=https://elara.piiix.org
STEP 18: Set CORS_ORIGIN=https://elara.piiix.org,https://chapters.piiix.org
STEP 19: Register OIDC callback for elara.piiix.org in identity provider
STEP 20: Update chapters-cloud provisioner image target to ghcr.io/piiix-org/elara
STEP 21: VERIFY — Full smoke test on elara.piiix.org:
           ✓ Login/signup flow
           ✓ Create vault + note
           ✓ Real-time collaboration (two tabs)
           ✓ MCP connection via POST /mcp
           ✓ Repository connect + sync
           ✓ Backup creation + download
           ✓ TOTP verification (existing enrolled user)
STEP 22: Run notification backfill SQL
STEP 23: Publish dual-tag container image (chapters + elara)
STEP 24: Enable 301 redirect on chapters.piiix.org (after 30-day dual window)
STEP 25: Update GitHub webhook URLs (GitLab: manual per-repo)
STEP 26: Remove chapters.piiix.org from CORS_ORIGIN
STEP 27: Deprecate ghcr.io/piiix-org/chapters image tag
```

---

---

# INSTANT ROLLBACK RUNBOOK

> [!CAUTION]
> If ANY step fails after deployment, execute this immediately.

```bash
# 1. Revert code to pre-rebrand commit
git revert HEAD   # or deploy previous tag
docker compose pull && docker compose up -d

# 2. Restore environment
# APP_URL=https://chapters.piiix.org
# CORS_ORIGIN=https://chapters.piiix.org

# 3. If notification backfill was applied, reverse it
docker compose exec db psql -U chapters chapters -c \
  "UPDATE notifications SET message = REPLACE(message, 'Elara', 'Chapters') WHERE message LIKE '%Elara%';"

# 4. If volume was migrated (Option B), swap mount back
# docker compose down
# Edit docker-compose.yml: elara-data → chapters-data
# docker compose up -d

# 5. DNS: elara.piiix.org can remain (harmless), no 301 was enabled yet
```

**Recovery time**: < 5 minutes for code revert, < 15 minutes for full rollback including database.

---

---

# ACCEPTANCE CRITERIA (ALL PHASES)

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (all client + server tests green)
- [ ] `docker build .` succeeds
- [ ] Fresh `docker compose up` with NO `.env` boots with `elara` defaults
- [ ] Existing deployment with `POSTGRES_USER=chapters` boots via dual-read fallback
- [ ] Session cookie `elara_session` is set on authenticated response
- [ ] Legacy `sid` cookie is accepted and transparently upgraded
- [ ] Logout clears all 3 cookie names
- [ ] Yjs room names remain `${vaultId}/${path}` — no brand prefix
- [ ] MCP `initialize` returns `serverInfo: { name: 'elara' }`
- [ ] MCP tools callable via both `POST /mcp` and `POST /elara/mcp`
- [ ] Backup filename matches `/^elara-backup-.*\.zip$/`
- [ ] Dual-pattern pruner counts both `chapters-backup-*` and `elara-backup-*`
- [ ] TOTP validation works for existing enrolled users
- [ ] Welcome email says "Elara" throughout
- [ ] All `/elara-*` slash commands work
- [ ] All `/chapters-*` slash commands forward to canonical handlers
- [ ] `elara.piiix.org` serves the full application
- [ ] `chapters.piiix.org` redirects (after 30-day window)
- [ ] Smoke test: login → vault → note → collab → MCP → repo → backup
