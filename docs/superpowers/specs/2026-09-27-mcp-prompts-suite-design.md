# Design Spec: Chapters MCP Prompts Suite (20 Engineering Prompts)

- **Date**: 2026-09-27
- **Author**: Taha-Mahmoodi
- **Status**: Approved & In Implementation
- **Target**: Chapters MCP Server (`server/src/mcp/`)

---

## 1. Executive Summary

Chapters provides an AI-navigable knowledge graph bridging Google Open Knowledge Format (OKF v0.2) Markdown vaults, synced Git repositories, AST symbols, and pgvector embeddings. While Chapters currently exposes 40+ MCP Tools, tools are passive: human developers and AI coding agents (Cursor, Claude Desktop, Windsurf, Antigravity, Devin) must formulate their own complex prompts to query the knowledge graph effectively.

This specification defines a comprehensive suite of **20 first-class MCP Prompts** implementing the standard `prompts/list` and `prompts/get` MCP protocol endpoints. These prompts provide context-hydrated, zero-hallucination workflow templates covering:
1. **Continuous Work Companion & Ingestion** (logging decisions during active coding and uploading local project docs).
2. **System Planning & Design** (ADRs, RFCs, implementation planning, context bundling, API specs).
3. **Code Understanding & Exploration** (architectural "Why", subsystem mental models, shortest-path concept navigation).
4. **Maintenance, Drift & Refactoring** (code-doc drift audits, blast radius analysis, orphaned code detection).
5. **Quality, Governance & Operations** (PR architectural compliance, release notes, security surface mapping, spec-to-test gap analysis, schema migration safety, incident post-mortems).

---

## 2. Technical Architecture & Dynamic Context Hydration

MCP Prompts in Chapters are not merely static prompt text strings. When an agent or user invokes `prompts/get` with parameters, Chapters executes a **Dynamic Context Hydration** pass:
- Queries the PostgreSQL database, AST symbol tables (`repository_file_symbols`), and git repository files.
- Traverses the knowledge graph via BFS pathfinding (`findShortestPath`) or incoming backlinks where relevant.
- Pre-populates the prompt messages with authoritative context (code definitions, existing ADRs, shortest path routes, frontmatter guidelines).

### Protocol Compatibility
- SDK: `@modelcontextprotocol/sdk/server/mcp.js` (`server.registerPrompt`).
- Handlers:
  - `prompts/list`: Exposes all 20 prompts, parameter descriptions, and required/optional Zod schemas.
  - `prompts/get`: Validates arguments, verifies connection scope & access permissions, executes context hydration, and returns structured `messages: [{ role: 'user', content: { type: 'text', text: ... } }]`.

---

## 3. Catalog of the 20 MCP Prompts

### Category 1: Continuous Working Companion & Knowledge Capture

#### 1. `active_project_companion` (Flagship)
- **Title**: Active Project Session Companion
- **Description**: Anchors an AI coding agent to a project's Chapters vault during development, commanding continuous capture of architecture choices, discovered invariants, and progress.
- **Arguments**:
  - `projectName` (string, required): Name of the project or repository.
  - `taskDescription` (string, required): What is being implemented or debugged.
  - `vaultId` (string, optional): Target vault ID.
- **Hydration**: Pulls `project/<name>` and `codebase/<name>` notes if present to establish baseline context and instructions.

#### 2. `sync_local_docs_to_vault` (Flagship)
- **Title**: Sync Local Documentation to Vault
- **Description**: Guides the agent to inspect markdown files across project directories (docs/, specs/, etc.), validate OKF v0.2 frontmatter, and upload them into the Chapters vault.
- **Arguments**:
  - `directoryPath` (string, required): Relative or local directory path to scan.
  - `vaultId` (string, optional): Target vault ID.

---

### Category 2: Planning & Feature Design

#### 3. `plan_feature_implementation`
- **Title**: Plan Feature Implementation
- **Description**: Formulates a step-by-step implementation plan grounded in existing specs and codebase patterns.
- **Arguments**:
  - `featureRequest` (string, required): Feature or enhancement requirements.
  - `repositoryName` (string, required): Target repository.
  - `vaultId` (string, optional): Vault containing architecture specs.

#### 4. `prepare_task_context`
- **Title**: Prepare Task Context Bundle
- **Description**: Extracts the minimal, high-signal bundle of relevant note excerpts, symbol definitions, and test files for an issue, eliminating token waste.
- **Arguments**:
  - `issueDescription` (string, required): Task or bug description.
  - `repositoryName` (string, required): Repository name.
  - `vaultId` (string, optional): Vault ID.

#### 5. `draft_adr`
- **Title**: Draft Architecture Decision Record (ADR)
- **Description**: Scaffolds an OKF v0.2 `type: adr` note with problem background, alternatives considered, trade-offs, and live AST links (`[[repo:name/file#symbol]]`).
- **Arguments**:
  - `title` (string, required): ADR title.
  - `problem` (string, required): Context and problem statement.
  - `decision` (string, required): Proposed architectural choice.
  - `codeTarget` (string, optional): File or symbol targeted (e.g. `src/auth.ts#verifyToken`).
  - `vaultId` (string, optional): Target vault ID.

#### 6. `draft_rfc`
- **Title**: Draft Request for Comments (RFC)
- **Description**: Scaffolds a full RFC specification with Mermaid architecture diagrams, threat models, performance considerations, and phased rollout.
- **Arguments**:
  - `systemChange` (string, required): Proposed system change.
  - `motivation` (string, required): Motivation and goals.
  - `vaultId` (string, optional): Target vault ID.

#### 7. `generate_api_spec`
- **Title**: Generate API Specification
- **Description**: Reverse-engineers a route controller or handler into a living OKF API spec note with request/response schemas and status codes.
- **Arguments**:
  - `routeFile` (string, required): File path of the route controller.
  - `endpointPath` (string, required): Endpoint route path (e.g. `/api/vaults/:id`).
  - `method` (string, required): HTTP method (GET, POST, PUT, DELETE).
  - `vaultId` (string, optional): Target vault ID.

---

### Category 3: Code Understanding & Onboarding

#### 8. `explain_code_architecture`
- **Title**: Explain Code Architecture & Context
- **Description**: Traverses backlinks and AST links from code to notes, pulling linked ADRs and design decisions to explain the architectural "Why".
- **Arguments**:
  - `repositoryName` (string, required): Repository name.
  - `filePath` (string, required): Code file path.
  - `symbol` (string, optional): Specific function, class, or type symbol.
  - `vaultId` (string, optional): Target vault ID.

#### 9. `onboard_subsystem`
- **Title**: Onboard to Subsystem
- **Description**: Generates a 5-minute architectural mental model: entrypoints, critical invariants (what must never break), and test suites.
- **Arguments**:
  - `subsystemName` (string, required): Subsystem name or keyword.
  - `repositoryName` (string, required): Repository name.
  - `vaultId` (string, optional): Target vault ID.

#### 10. `summarize_concept_chain`
- **Title**: Summarize Concept Chain (Pathfinding)
- **Description**: Uses BFS graph pathfinding to explain the causal and architectural chain connecting two distant concepts or modules.
- **Arguments**:
  - `sourceNode` (string, required): Starting note path or code symbol.
  - `targetNode` (string, required): Destination note path or code symbol.
  - `vaultId` (string, optional): Target vault ID.

---

### Category 4: Maintenance, Drift & Refactoring

#### 11. `audit_architecture_drift`
- **Title**: Audit Architecture Drift
- **Description**: Compares recent code modifications or git diffs against linked notes and outputs a structured drift report with exact proposed doc edits.
- **Arguments**:
  - `repositoryName` (string, required): Repository name.
  - `filePath` (string, optional): Specific file or folder to audit.
  - `gitDiff` (string, optional): Git diff snippet or summary.
  - `vaultId` (string, optional): Target vault ID.

#### 12. `refactor_impact_analysis`
- **Title**: Refactor Impact Analysis (Blast Radius)
- **Description**: Maps code consumers, incoming note references, linked specifications, and test files that will be affected before a symbol is refactored.
- **Arguments**:
  - `repositoryName` (string, required): Repository name.
  - `targetSymbol` (string, required): Function, class, or symbol to refactor.
  - `vaultId` (string, optional): Target vault ID.

#### 13. `audit_orphaned_code`
- **Title**: Audit Orphaned Code (Architectural Dark Matter)
- **Description**: Identifies code modules and core services with zero documentation or references in the vault.
- **Arguments**:
  - `repositoryName` (string, required): Repository name.
  - `vaultId` (string, optional): Target vault ID.

---

### Category 5: Quality, Governance & Operations

#### 14. `test_gap_analysis`
- **Title**: Test Gap Analysis
- **Description**: Verifies that business requirements and edge cases written in technical specs actually have matching automated tests.
- **Arguments**:
  - `specPath` (string, required): Path to specification note in vault.
  - `repositoryName` (string, required): Repository containing test suite.
  - `vaultId` (string, optional): Target vault ID.

#### 15. `pr_review_against_specs`
- **Title**: Pull Request Review Against Specifications
- **Description**: Reviews a PR diff against established ADRs and invariants in Chapters to prevent architectural regressions.
- **Arguments**:
  - `prDiffOrSummary` (string, required): Diff or PR summary.
  - `repositoryName` (string, required): Repository name.
  - `vaultId` (string, optional): Target vault ID.

#### 16. `generate_release_notes`
- **Title**: Generate Release Notes & Technical Changelog
- **Description**: Generates dual-tiered release notes (user highlights + technical changelog) from landed specs, ADRs, and commits.
- **Arguments**:
  - `fromRef` (string, required): Previous tag or commit.
  - `toRef` (string, required): Current tag or commit.
  - `repositoryName` (string, required): Repository name.
  - `vaultId` (string, optional): Target vault ID.

#### 17. `audit_security_surface`
- **Title**: Audit Security & Attack Surface
- **Description**: Maps authentication checkpoints, token handlers, and cryptographic routines against documented security policies.
- **Arguments**:
  - `repositoryName` (string, required): Repository name.
  - `vaultId` (string, optional): Target vault ID.

#### 18. `database_schema_evolution`
- **Title**: Database Schema Evolution & Migration Review
- **Description**: Safety review for database schema changes & migrations (lock contention, data loss, backward compatibility).
- **Arguments**:
  - `proposedSchemaOrMigration` (string, required): Schema diff or migration SQL.
  - `repositoryName` (string, required): Repository name.
  - `vaultId` (string, optional): Target vault ID.

#### 19. `supernode_bottleneck_audit`
- **Title**: Supernode & Coupling Bottleneck Audit
- **Description**: Identifies the highest-degree, tightly coupled nodes across code and notes to spot single points of failure.
- **Arguments**:
  - `vaultId` (string, optional): Vault ID.
  - `repositoryName` (string, optional): Repository name.

#### 20. `incident_postmortem`
- **Title**: Incident Post-Mortem Generator
- **Description**: Scaffolds a blameless post-mortem note linking failure timelines, impacted code lines/commits, root causes, and preventative action items.
- **Arguments**:
  - `incidentTitle` (string, required): Incident title.
  - `symptoms` (string, required): Observable symptoms and impact.
  - `rootCause` (string, required): Identified root cause.
  - `affectedSymbols` (string, optional): Affected code files/symbols.
  - `vaultId` (string, optional): Target vault ID.

---

## 4. Verification & Testing

- Unit tests in `server/test/mcp-prompts.test.ts` testing:
  1. `client.listPrompts()` returns all 20 prompts with complete descriptions and arguments.
  2. `client.getPrompt()` dynamically generates valid `messages` for flagship prompts (`active_project_companion`, `sync_local_docs_to_vault`, `draft_adr`, `summarize_concept_chain`, etc.).
  3. Scope and permission validation guards (vault vs repository vs account scoped connections).
- Zero linter errors, 0 TypeScript errors.
