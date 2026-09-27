import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpAuth } from '../vaults/mcp-connection-routes.js'
import { buildGraph, findShortestPath } from '../graph/assemble.js'
import { searchNotes } from '../search/search.js'
import { readNote } from '../notes/store.js'

export class McpPromptError extends Error {}

export interface PromptHelpers {
  vaultFor: (requested?: string) => string
  repositoryFor: (requested?: string) => string
  requireAccess: (vaultId: string, needed: 'read' | 'edit') => Promise<void>
  requireRepositoryAccess: (repositoryId: string) => Promise<void>
}

/**
 * Registers Chapters' 20 first-class MCP Prompts implementing the standard
 * `prompts/list` and `prompts/get` protocol endpoints.
 */
export function registerMcpPrompts(
  server: McpServer,
  auth: McpAuth,
  helpers: PromptHelpers,
): void {
  const { vaultFor, requireAccess } = helpers

  // =========================================================================
  // 1. ACTIVE PROJECT COMPANION (Flagship)
  // =========================================================================
  server.registerPrompt(
    'active_project_companion',
    {
      title: 'Active Project Session Companion',
      description:
        'Continuous work session companion: anchors the AI agent to the project vault, commanding real-time capture of decisions and notes as code is written.',
      argsSchema: {
        projectName: z.string().describe('Name of the project or repository being worked on'),
        taskDescription: z.string().describe('Description of the feature, refactor, or bug being addressed'),
        vaultId: z.string().optional().describe('Target vault ID in Chapters'),
      },
    },
    async ({ projectName, taskDescription, vaultId: reqVaultId }) => {
      let vaultId: string | null = null
      let baselineContext = ''
      try {
        vaultId = vaultFor(reqVaultId)
        await requireAccess(vaultId, 'edit')
        const projectNote = await readNote(vaultId, `project/${projectName}`).catch(() => null)
        const codebaseNote = await readNote(vaultId, `codebase/${projectName}`).catch(() => null)
        if (projectNote) baselineContext += `\nExisting Project Note:\n${projectNote.body.slice(0, 800)}\n`
        if (codebaseNote) baselineContext += `\nExisting Codebase Note:\n${codebaseNote.body.slice(0, 800)}\n`
      } catch {
        // Fallback gracefully if vault not yet linked
      }

      const instructions = `You are actively pairing on project "${projectName}" using Chapters as the project's living second brain.

TASK OBJECTIVE:
"${taskDescription}"
${baselineContext ? `\nBASELINE KNOWLEDGE BASE CONTEXT:${baselineContext}` : ''}
CONTINUOUS WORKFLOW MANDATE:
1. ANCHOR: Establish or update a session log note at \`session/${new Date().toISOString().slice(0, 10)}-${projectName}\` using the \`create_note\` or \`edit_note\` tool.
2. CONTINUOUS CAPTURE: As you make architectural decisions, discover invariants, or modify code, IMMEDIATELY record them in Chapters notes. Never let technical context stay trapped in this chat session.
3. AST CODE LINKS: Cross-link technical documentation directly to code using \`[[repo:${projectName}/<filepath>#<symbol>]]\` format.
4. WRAP-UP SUMMARY: At the conclusion of this task, update the session note and relevant specs so future developers or AI agents have complete continuity.`

      return {
        description: `Active companion session for ${projectName}: ${taskDescription}`,
        messages: [{ role: 'user', content: { type: 'text', text: instructions } }],
      }
    },
  )

  // =========================================================================
  // 2. SYNC LOCAL DOCS TO VAULT (Flagship)
  // =========================================================================
  server.registerPrompt(
    'sync_local_docs_to_vault',
    {
      title: 'Sync Local Documentation to Vault',
      description:
        'Zero-friction uploader: scans local markdown notes in project directories (docs/, specs/, etc.) and uploads them to the Chapters vault.',
      argsSchema: {
        directoryPath: z.string().describe('Relative path to local directory containing markdown docs (e.g. "docs/")'),
        vaultId: z.string().optional().describe('Target vault ID'),
      },
    },
    async ({ directoryPath, vaultId: reqVaultId }) => {
      const vaultId = vaultFor(reqVaultId)
      await requireAccess(vaultId, 'edit')

      const text = `You are uploading local project documentation from directory "${directoryPath}" into Chapters vault "${vaultId}".

INSTRUCTIONS:
1. INSPECT: Read the markdown files in "${directoryPath}" using your local filesystem tools.
2. VALIDATE OKF v0.2:
   - File path must follow \`<type>/<name>\` slug format (e.g., \`spec/auth\`, \`docs/architecture\`, \`adr/storage-layer\`).
   - Frontmatter must contain \`type: <type>\` matching the path prefix.
   - Slugs must be lowercase alphanumeric with hyphens (^[a-z0-9][a-z0-9-]*$).
3. UPLOAD / UPSERT: For each valid file, call Chapters MCP \`create_note\` or \`edit_note\` with the target \`vaultId: "${vaultId}"\`.
4. REPORT: Output a summary table of all uploaded notes, their resolved paths, and any files skipped due to format issues.`

      return {
        description: `Sync local documentation from ${directoryPath} to vault ${vaultId}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 3. PLAN FEATURE IMPLEMENTATION
  // =========================================================================
  server.registerPrompt(
    'plan_feature_implementation',
    {
      title: 'Plan Feature Implementation',
      description:
        'Grounded implementation planner: inspects existing specs and codebase patterns in Chapters to formulate a step-by-step, zero-hallucination plan.',
      argsSchema: {
        featureRequest: z.string().describe('The user request, bug, or feature to plan'),
        repositoryName: z.string().describe('Target repository name'),
        vaultId: z.string().optional().describe('Vault containing architecture notes'),
      },
    },
    async ({ featureRequest, repositoryName, vaultId: reqVaultId }) => {
      let relevantNotes = ''
      try {
        const vaultId = vaultFor(reqVaultId)
        await requireAccess(vaultId, 'read')
        const results = await searchNotes({ vaultIds: [vaultId], repositoryIds: [] }, featureRequest)
        if (results.length > 0) {
          relevantNotes = results
            .slice(0, 3)
            .map((r) => `- [[${r.path}]]: ${r.snippet?.slice(0, 100) ?? r.path} (score: ${r.score})`)
            .join('\n')
        }
      } catch {
        // Vault optional
      }

      const text = `Plan the implementation for the following feature in repository "${repositoryName}":

FEATURE REQUEST:
"${featureRequest}"
${relevantNotes ? `\nRELEVANT SPECIFICATIONS IN CHAPTERS:\n${relevantNotes}\n` : ''}
PLANNING GUIDELINES:
1. INVESTIGATE: Use Chapters MCP tools (\`search\`, \`find_symbols\`, \`browse_repository\`) to examine existing code patterns and invariants.
2. ARCHITECTURAL CONSTRAINTS: Review any matching ADRs or specs before deciding on approach. Avoid anti-patterns previously decided against.
3. STEP-BY-STEP PLAN:
   - Phase 1: Schema / data model changes (if any).
   - Phase 2: Core server logic and API contracts.
   - Phase 3: Client UI components, routing, and state.
   - Phase 4: Automated unit, integration, and accessibility tests.
4. SPEC UPDATES: List which documentation notes in Chapters should be updated when this feature ships.`

      return {
        description: `Implementation plan for ${featureRequest}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 4. PREPARE TASK CONTEXT
  // =========================================================================
  server.registerPrompt(
    'prepare_task_context',
    {
      title: 'Prepare Task Context Bundle',
      description:
        'Minimal token burn context bundler: extracts the high-signal bundle of relevant note excerpts, symbol definitions, and test files for a specific task.',
      argsSchema: {
        issueDescription: z.string().describe('Task, bug, or issue description'),
        repositoryName: z.string().describe('Repository name'),
        vaultId: z.string().optional().describe('Vault ID'),
      },
    },
    async ({ issueDescription, repositoryName, vaultId: reqVaultId }) => {
      let hydratedContext = ''
      try {
        const vaultId = vaultFor(reqVaultId)
        await requireAccess(vaultId, 'read')
        const hits = await searchNotes({ vaultIds: [vaultId], repositoryIds: [] }, issueDescription)
        for (const hit of hits.slice(0, 3)) {
          const note = await readNote(vaultId, hit.path).catch(() => null)
          if (note) hydratedContext += `\n--- Note: [[${hit.path}]] ---\n${note.body.slice(0, 600)}\n`
        }
      } catch {
        // Optional
      }

      const text = `You are preparing an optimal, token-efficient context bundle for an AI coding agent working on:

TASK:
"${issueDescription}"
REPOSITORY: "${repositoryName}"
${hydratedContext ? `\nHYDRATED KNOWLEDGE EXCERPTS:${hydratedContext}\n` : ''}
INSTRUCTIONS:
1. Synthesize the core problem and essential business rules.
2. Use \`find_symbols\` to identify the exact functions, classes, and types that touch this logic.
3. Locate the primary test files that currently cover this area.
4. Deliver a concise context briefing containing only actionable code symbols and constraints.`

      return {
        description: `Context bundle for: ${issueDescription}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 5. DRAFT ADR
  // =========================================================================
  server.registerPrompt(
    'draft_adr',
    {
      title: 'Draft Architecture Decision Record (ADR)',
      description:
        'Scaffolds a compliant Google OKF v0.2 ADR note with problem statement, options considered, trade-offs, and live AST links to code.',
      argsSchema: {
        title: z.string().describe('Title of the architecture decision'),
        problem: z.string().describe('Problem statement and motivation'),
        decision: z.string().describe('The proposed decision or solution'),
        codeTarget: z.string().optional().describe('Target code symbol or file (e.g. "server/src/auth.ts#verifyToken")'),
        vaultId: z.string().optional().describe('Target vault ID'),
      },
    },
    async ({ title, problem, decision, codeTarget, vaultId: reqVaultId }) => {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      const codeLink = codeTarget ? `[[repo:${codeTarget}]]` : ''
      if (reqVaultId) {
        try {
          const vaultId = vaultFor(reqVaultId)
          await requireAccess(vaultId, 'edit')
        } catch {
          // optional
        }
      }

      const text = `Draft an Architecture Decision Record (ADR) in Google Open Knowledge Format (OKF v0.2) ready to be stored in Chapters.

INPUTS:
- Title: ${title}
- Problem: ${problem}
- Decision: ${decision}
${codeTarget ? `- Code Target: ${codeTarget}` : ''}

TEMPLATE STRUCTURE TO GENERATE:
---
type: adr
title: "${title}"
status: proposed
date: "${new Date().toISOString().slice(0, 10)}"
tags:
  - adr
  - architecture
${codeTarget ? `references:\n  - "${codeTarget}"\n` : ''}---

# ADR: ${title}

## Context & Problem Statement
${problem}

## Decision Drivers
- Simplicity and maintainability.
- Performance and operational reliability.
- Preservation of established invariants.

## Considered Options
1. **${decision}** (Chosen)
2. Alternative approach A (Document why rejected)
3. Alternative approach B (Document why rejected)

## Decision Outcome
Chosen option: **${decision}**

### Positive Consequences
- ...

### Negative Consequences / Trade-offs
- ...

## Links & Code References
${codeLink ? `- Target Implementation: ${codeLink}` : '- Related components: ...'}

INSTRUCTION: Output the complete, production-ready markdown note, then ask if the user wants you to call \`create_note\` to save it at \`adr/${slug}\`.`

      return {
        description: `Draft ADR: ${title}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 6. DRAFT RFC
  // =========================================================================
  server.registerPrompt(
    'draft_rfc',
    {
      title: 'Draft Request for Comments (RFC)',
      description:
        'Scaffolds a comprehensive RFC specification with Mermaid architecture diagrams, threat models, performance considerations, and rollout phases.',
      argsSchema: {
        systemChange: z.string().describe('Name or topic of the proposed system change'),
        motivation: z.string().describe('Why this change is needed and what it enables'),
        vaultId: z.string().optional().describe('Target vault ID'),
      },
    },
    async ({ systemChange, motivation }) => {
      const slug = systemChange.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      const text = `Draft a Request for Comments (RFC) specification in OKF v0.2 format for:

SYSTEM CHANGE: ${systemChange}
MOTIVATION: ${motivation}

REQUIRED SECTIONS:
---
type: rfc
title: "RFC: ${systemChange}"
status: draft
author: Chapters Agent
created: "${new Date().toISOString().slice(0, 10)}"
tags:
  - rfc
  - specification
---

# RFC: ${systemChange}

## 1. Executive Summary & Goals
${motivation}

## 2. Architecture & Data Flow
Include a clean Mermaid sequence or flowchart diagram:
\`\`\`mermaid
flowchart TD
  Client --> API
  API --> Engine
\`\`\`

## 3. Detailed Component Design
- Data structures and schemas.
- REST / WebSocket / MCP contracts.
- Error handling & edge cases.

## 4. Security & Compliance
- Auth scopes, permissions, input sanitization, and data privacy.

## 5. Performance & Operational Impact
- Latency, memory footprint, database query bounds.

## 6. Migration & Rollout Plan
- Phase 1: Dark launch / feature flag.
- Phase 2: Migration and verification.
- Phase 3: Deprecation of legacy code.

Output the complete RFC note and offer to save it at \`rfc/${slug}\`.`

      return {
        description: `Draft RFC for: ${systemChange}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 7. GENERATE API SPEC
  // =========================================================================
  server.registerPrompt(
    'generate_api_spec',
    {
      title: 'Generate API Specification',
      description:
        'Reverse-engineers a route controller or handler into a living OKF API spec note with request/response schemas and status codes.',
      argsSchema: {
        routeFile: z.string().describe('Path to the route handler file in repository'),
        endpointPath: z.string().describe('Route path (e.g. "/api/vaults/:id/notes")'),
        method: z.string().describe('HTTP Method: GET, POST, PUT, DELETE, PATCH'),
        vaultId: z.string().optional().describe('Target vault ID'),
      },
    },
    async ({ routeFile, endpointPath, method }) => {
      const text = `Inspect the implementation of endpoint "${method.toUpperCase()} ${endpointPath}" in "${routeFile}" and generate an authoritative OKF API specification note.

INSTRUCTIONS:
1. Inspect "${routeFile}" to understand:
   - Authentication and authorization guards (session, token, role).
   - Request params, query string, and body validation schema (e.g. Zod).
   - Success response payload shape and HTTP status code.
   - Error responses (400, 401, 403, 404, 409, 500).
2. Generate an OKF note with frontmatter:
---
type: spec
title: "${method.toUpperCase()} ${endpointPath}"
status: active
category: api
endpoint: "${endpointPath}"
method: "${method.toUpperCase()}"
source_file: "${routeFile}"
---

Include curl examples, payload schemas, and error tables. Offer to save it as \`spec/api-${slugify(endpointPath)}\`.`

      return {
        description: `API spec for ${method.toUpperCase()} ${endpointPath}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 8. EXPLAIN CODE ARCHITECTURE
  // =========================================================================
  server.registerPrompt(
    'explain_code_architecture',
    {
      title: 'Explain Code Architecture & Context',
      description:
        'Traverses backlinks and AST links from code to notes, pulling linked ADRs and design decisions to explain the architectural "Why".',
      argsSchema: {
        repositoryName: z.string().describe('Repository name'),
        filePath: z.string().describe('Path to the code file'),
        symbol: z.string().optional().describe('Specific function, class, or type symbol'),
        vaultId: z.string().optional().describe('Vault ID'),
      },
    },
    async ({ repositoryName, filePath, symbol, vaultId: reqVaultId }) => {
      let linkedNotesSummary = ''
      try {
        const vaultId = vaultFor(reqVaultId)
        await requireAccess(vaultId, 'read')
        const query = symbol || filePath
        const hits = await searchNotes({ vaultIds: [vaultId], repositoryIds: [] }, query)
        if (hits.length > 0) {
          linkedNotesSummary = hits
            .slice(0, 3)
            .map((h) => `- [[${h.path}]]: ${h.snippet?.slice(0, 80) ?? h.path}`)
            .join('\n')
        }
      } catch {
        // Optional
      }

      const text = `Explain the architectural context, design rationale, and invariants of "${filePath}"${symbol ? ` (symbol: ${symbol})` : ''} in repository "${repositoryName}".
${linkedNotesSummary ? `\nCONNECTED CHAPTERS NOTES:\n${linkedNotesSummary}\n` : ''}
ANALYSIS GUIDELINES:
1. Trace backwards from the code to existing design documents and ADRs in Chapters.
2. Explain WHY this component was designed this way:
   - What problems or constraints was it built to solve?
   - What architectural trade-offs were made?
   - What core invariants MUST NOT be broken when modifying this code?
3. Mention which test files verify this component and what scenarios they cover.`

      return {
        description: `Architecture explanation for ${filePath}${symbol ? `#${symbol}` : ''}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 9. ONBOARD SUBSYSTEM
  // =========================================================================
  server.registerPrompt(
    'onboard_subsystem',
    {
      title: 'Onboard to Subsystem',
      description:
        '5-minute architectural mental model: entrypoints, critical invariants (what must never break), and test suites for any subsystem.',
      argsSchema: {
        subsystemName: z.string().describe('Name or topic of the subsystem (e.g. "Collaboration Relay", "Vector Search")'),
        repositoryName: z.string().describe('Repository name'),
        vaultId: z.string().optional().describe('Vault ID'),
      },
    },
    async ({ subsystemName, repositoryName }) => {
      const text = `Provide a rapid 5-minute architectural onboarding briefing for the "${subsystemName}" subsystem in "${repositoryName}".

STRUCTURE OF THE BRIEFING:
1. High-Level Mental Model: In 2-3 sentences, what is this subsystem's responsibility?
2. Primary Entrypoints & File Roster: Which 3-5 files own the core logic?
3. Critical Invariants: What assumptions, concurrency rules, or security guarantees must NEVER be violated?
4. Data Flow: How does an input move through this subsystem from arrival to persistence?
5. Guard Tests: Which test files should an engineer run when touching this subsystem?`

      return {
        description: `Onboarding guide for ${subsystemName}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 10. SUMMARIZE CONCEPT CHAIN
  // =========================================================================
  server.registerPrompt(
    'summarize_concept_chain',
    {
      title: 'Summarize Concept Chain (Pathfinding)',
      description:
        'Uses BFS graph pathfinding to explain the causal and architectural chain connecting two distant concepts or modules.',
      argsSchema: {
        sourceNode: z.string().describe('Starting note path or code symbol'),
        targetNode: z.string().describe('Target note path or code symbol'),
        vaultId: z.string().optional().describe('Vault ID'),
      },
    },
    async ({ sourceNode, targetNode, vaultId: reqVaultId }) => {
      let pathInfo = ''
      try {
        const vaultId = vaultFor(reqVaultId)
        await requireAccess(vaultId, 'read')
        const graph = await buildGraph({ vaultIds: [vaultId], repositoryIds: [] })
        const sourceNodeObj = graph.nodes.find((n) => n.id === sourceNode || n.path === sourceNode)
        const targetNodeObj = graph.nodes.find((n) => n.id === targetNode || n.path === targetNode)
        if (sourceNodeObj && targetNodeObj) {
          const path = findShortestPath(graph, sourceNodeObj.id, targetNodeObj.id)
          if (path.found && path.nodes.length > 0) {
            pathInfo =
              `\nDISCOVERED GRAPH PATH (${path.distance} hops):\n` +
              path.nodes.map((n, i) => `  ${i + 1}. [${n.resourceType}] ${n.path} (${n.id})`).join('\n') +
              `\nEDGES:\n` +
              path.edges.map((e) => `  - ${e.source} -> ${e.target} (${e.kind})`).join('\n')
          }
        }
      } catch {
        // Fallback
      }

      const text = `Explain the architectural connection between "${sourceNode}" and "${targetNode}".
${pathInfo ? `\n${pathInfo}\n` : ''}
INSTRUCTIONS:
1. Detail how concept "${sourceNode}" flows into or influences "${targetNode}".
2. Explain each step in the chain: why the connection exists (explicit wikilink, semantic similarity, or code import).
3. Highlight any architectural bottlenecks or bridge nodes along the path.`

      return {
        description: `Concept chain between ${sourceNode} and ${targetNode}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 11. AUDIT ARCHITECTURE DRIFT
  // =========================================================================
  server.registerPrompt(
    'audit_architecture_drift',
    {
      title: 'Audit Architecture Drift',
      description:
        'Compares recent code modifications or git diffs against linked notes and outputs a structured drift report with exact proposed doc edits.',
      argsSchema: {
        repositoryName: z.string().describe('Repository name'),
        filePath: z.string().optional().describe('Specific file or directory being audited'),
        gitDiff: z.string().optional().describe('Recent git diff or summary of changes'),
        vaultId: z.string().optional().describe('Vault ID'),
      },
    },
    async ({ repositoryName, filePath, gitDiff }) => {
      const text = `Audit code-to-documentation drift in repository "${repositoryName}"${filePath ? ` for "${filePath}"` : ''}.
${gitDiff ? `\nRECENT CODE MODIFICATIONS / DIFF:\n${gitDiff.slice(0, 1500)}\n` : ''}
DRIFT AUDIT PROTOCOL:
1. IDENTIFY LINKED NOTES: Use Chapters MCP \`search\` or \`find_symbols\` to identify notes, specs, and ADRs referencing the modified files/symbols.
2. CHECK CONTRACT DIVERGENCE:
   - Have function signatures, parameter names, or return shapes changed?
   - Have documented security invariants or error codes been modified?
   - Are there newly added exports that have no corresponding documentation?
3. STRUCTURED DRIFT REPORT:
   - Stale Notes: List each note path and exact obsolete paragraphs.
   - Proposed Diffs: Provide drop-in replacements for the outdated documentation.`

      return {
        description: `Drift audit for ${repositoryName}${filePath ? `/${filePath}` : ''}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 12. REFACTOR IMPACT ANALYSIS
  // =========================================================================
  server.registerPrompt(
    'refactor_impact_analysis',
    {
      title: 'Refactor Impact Analysis (Blast Radius)',
      description:
        'Maps code consumers, incoming note references, linked specifications, and test files that will be affected before a symbol is refactored.',
      argsSchema: {
        repositoryName: z.string().describe('Repository name'),
        targetSymbol: z.string().describe('Function, class, or symbol to refactor'),
        vaultId: z.string().optional().describe('Vault ID'),
      },
    },
    async ({ repositoryName, targetSymbol }) => {
      const text = `Perform a comprehensive pre-refactor blast radius analysis for symbol "${targetSymbol}" in "${repositoryName}".

BLAST RADIUS CHECKLIST:
1. CODE CONSUMERS: Find all repository files importing or invoking "${targetSymbol}".
2. KNOWLEDGE BASE LINKS: Search Chapters for specs, ADRs, and wikilinks targeting this symbol (\`[[repo:${repositoryName}/...#${targetSymbol}]]\`).
3. TEST SUITE EXPOSURE: Identify test files that assert this symbol's behavior.
4. BREAKING CHANGE ASSESSMENT:
   - What downstream consumers will fail if the signature or return type changes?
   - What migration or deprecation steps are recommended?`

      return {
        description: `Blast radius analysis for ${targetSymbol}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 13. AUDIT ORPHANED CODE
  // =========================================================================
  server.registerPrompt(
    'audit_orphaned_code',
    {
      title: 'Audit Orphaned Code (Architectural Dark Matter)',
      description:
        'Identifies code modules and core services with zero documentation or references in the vault, uncovering technical blind spots.',
      argsSchema: {
        repositoryName: z.string().describe('Repository name'),
        vaultId: z.string().optional().describe('Vault ID'),
      },
    },
    async ({ repositoryName }) => {
      const text = `Audit repository "${repositoryName}" to identify architectural dark matter: critical code modules that lack any documentation in Chapters.

INSTRUCTIONS:
1. List the top-level modules and services in the repository.
2. Query Chapters notes using \`search\` to check which files or services are referenced in specs and ADRs.
3. Highlight high-complexity files (>200 lines) with zero note references.
4. Output a prioritized list of documentation gaps for the engineering team.`

      return {
        description: `Orphaned code audit for ${repositoryName}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 14. TEST GAP ANALYSIS
  // =========================================================================
  server.registerPrompt(
    'test_gap_analysis',
    {
      title: 'Test Gap Analysis',
      description:
        'Verifies that business requirements and edge cases written in technical specs actually have matching automated tests.',
      argsSchema: {
        specPath: z.string().describe('Path to the specification note in vault (e.g. "spec/scheduled-backups")'),
        repositoryName: z.string().describe('Repository containing test suite'),
        vaultId: z.string().optional().describe('Vault ID'),
      },
    },
    async ({ specPath, repositoryName, vaultId: reqVaultId }) => {
      let specBody = ''
      try {
        const vaultId = vaultFor(reqVaultId)
        await requireAccess(vaultId, 'read')
        const note = await readNote(vaultId, specPath).catch(() => null)
        if (note) specBody = note.body.slice(0, 1200)
      } catch {
        // Optional
      }

      const text = `Audit test coverage against specification "[[${specPath}]]" in repository "${repositoryName}".
${specBody ? `\nSPECIFICATION BODY:\n${specBody}\n` : ''}
AUDIT PROTOCOL:
1. Extract every distinct functional requirement, security invariant, and error condition listed in the spec.
2. Locate the corresponding test files in the repository.
3. Compare requirements against test assertions (\`it('...')\`, \`expect(...)\`).
4. Output a Compliance Matrix:
   - [Covered] Requirement -> Matching test description & file.
   - [GAP] Requirement -> Missing test scenario and suggested test implementation.`

      return {
        description: `Test gap analysis for ${specPath}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 15. PR REVIEW AGAINST SPECS
  // =========================================================================
  server.registerPrompt(
    'pr_review_against_specs',
    {
      title: 'Pull Request Review Against Specifications',
      description:
        'Reviews a PR diff against established ADRs and invariants in Chapters to prevent architectural regressions.',
      argsSchema: {
        prDiffOrSummary: z.string().describe('Git diff or PR summary to review'),
        repositoryName: z.string().describe('Repository name'),
        vaultId: z.string().optional().describe('Vault ID'),
      },
    },
    async ({ prDiffOrSummary, repositoryName }) => {
      const text = `Perform an architectural review of the following pull request in repository "${repositoryName}":

PR CHANGES / DIFF:
${prDiffOrSummary.slice(0, 2000)}

REVIEW CRITERIA:
1. ADR COMPLIANCE: Does this PR introduce patterns or libraries previously decided against in an ADR?
2. INVARIANT PRESERVATION: Does it violate any system invariants (e.g. auth bypass, unindexed database queries, leaky abstractions)?
3. SECURITY & ACCESSIBILITY: Does it introduce new endpoints without authentication or UI components without accessibility?
4. DOCUMENTATION SYNC: What notes in Chapters need to be updated before this PR merges?`

      return {
        description: `Architectural PR review for ${repositoryName}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 16. GENERATE RELEASE NOTES
  // =========================================================================
  server.registerPrompt(
    'generate_release_notes',
    {
      title: 'Generate Release Notes & Technical Changelog',
      description:
        'Generates dual-tiered release notes (user highlights + technical changelog) from landed specs, ADRs, and commits.',
      argsSchema: {
        fromRef: z.string().describe('Previous tag or commit (e.g. "v1.2.0")'),
        toRef: z.string().describe('Current tag or commit (e.g. "v1.3.0" or "HEAD")'),
        repositoryName: z.string().describe('Repository name'),
        vaultId: z.string().optional().describe('Vault ID'),
      },
    },
    async ({ fromRef, toRef, repositoryName }) => {
      const text = `Generate dual-tiered release notes for repository "${repositoryName}" from ${fromRef} to ${toRef}.

OUTPUT STRUCTURE:
1. Product Highlights (User-Facing):
   - Clear, non-technical bullet points describing new capabilities and user benefits.
2. Technical Changelog (Engineer-Facing):
   - Architecture decisions & ADRs implemented.
   - Breaking API changes and required client migrations.
   - Database migrations and operational considerations.
   - Performance improvements and bug fixes.`

      return {
        description: `Release notes for ${repositoryName} (${fromRef}..${toRef})`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 17. AUDIT SECURITY SURFACE
  // =========================================================================
  server.registerPrompt(
    'audit_security_surface',
    {
      title: 'Audit Security & Attack Surface',
      description:
        'Maps authentication checkpoints, token handlers, and cryptographic routines against documented security policies.',
      argsSchema: {
        repositoryName: z.string().describe('Repository name'),
        vaultId: z.string().optional().describe('Vault ID'),
      },
    },
    async ({ repositoryName }) => {
      const text = `Audit the security attack surface of "${repositoryName}".

SECURITY AUDIT CHECKLIST:
1. AUTH GUARDS: Verify that every REST route and MCP tool enforces authentication unless explicitly public.
2. INPUT SANITIZATION: Check for path traversal guards on file routes and SQL injection prevention in database queries.
3. CRYPTOGRAPHIC INTEGRITY: Check password hashing, token hashing, and session expiry logic against documented security notes.
4. PERMISSION BOUNDARIES: Ensure tenant isolation, RBAC checks, and scope enforcement (e.g. vault-scoped vs account-scoped tokens).`

      return {
        description: `Security surface audit for ${repositoryName}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 18. DATABASE SCHEMA EVOLUTION
  // =========================================================================
  server.registerPrompt(
    'database_schema_evolution',
    {
      title: 'Database Schema Evolution & Migration Review',
      description:
        'Safety review for database schema changes & migrations (lock contention, data loss, backward compatibility).',
      argsSchema: {
        proposedSchemaOrMigration: z.string().describe('Proposed schema diff or migration SQL'),
        repositoryName: z.string().describe('Repository name'),
        vaultId: z.string().optional().describe('Vault ID'),
      },
    },
    async ({ proposedSchemaOrMigration, repositoryName }) => {
      const text = `Perform a database migration safety review for repository "${repositoryName}":

PROPOSED MIGRATION / SCHEMA DIFF:
${proposedSchemaOrMigration.slice(0, 2000)}

MIGRATION SAFETY CHECKLIST:
1. LOCK RISKS: Does the migration add columns with non-null defaults without nullable backfills or hold table locks?
2. DATA LOSS & BACKWARD COMPATIBILITY: Can the currently running application code run safely against this schema before new code deploys?
3. INDEXING: Are foreign keys and query filter columns indexed properly?
4. DOCUMENTATION: Does the data model note in Chapters reflect these changes?`

      return {
        description: `Database schema migration review for ${repositoryName}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 19. SUPERNODE BOTTLENECK AUDIT
  // =========================================================================
  server.registerPrompt(
    'supernode_bottleneck_audit',
    {
      title: 'Supernode & Coupling Bottleneck Audit',
      description:
        'Identifies the highest-degree, tightly coupled nodes across code and notes to spot single points of failure.',
      argsSchema: {
        vaultId: z.string().optional().describe('Vault ID'),
        repositoryName: z.string().optional().describe('Repository name'),
      },
    },
    async ({ vaultId: reqVaultId }) => {
      if (reqVaultId) {
        try {
          const vaultId = vaultFor(reqVaultId)
          await requireAccess(vaultId, 'read')
        } catch {
          // optional
        }
      }
      const text = `Analyze the knowledge graph topology to identify supernodes and tight coupling bottlenecks.

INVESTIGATION STEPS:
1. Using Chapters MCP graph tools, identify nodes with unusually high in-degree or out-degree connections.
2. Distinguish intentional hubs (e.g. main index notes) from problematic God objects (code files or specs that everything depends on).
3. Outline refactoring and decoupling strategies to reduce architectural fragility.`

      return {
        description: 'Supernode and bottleneck audit',
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )

  // =========================================================================
  // 20. INCIDENT POST-MORTEM
  // =========================================================================
  server.registerPrompt(
    'incident_postmortem',
    {
      title: 'Incident Post-Mortem Generator',
      description:
        'Scaffolds a blameless post-mortem note linking failure timelines, impacted code lines/commits, root causes, and preventative action items.',
      argsSchema: {
        incidentTitle: z.string().describe('Title of the incident'),
        symptoms: z.string().describe('Observable symptoms and customer impact'),
        rootCause: z.string().describe('Identified root cause'),
        affectedSymbols: z.string().optional().describe('Affected code files or AST symbols'),
        vaultId: z.string().optional().describe('Target vault ID'),
      },
    },
    async ({ incidentTitle, symptoms, rootCause, affectedSymbols }) => {
      const slug = incidentTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      const text = `Draft a blameless incident post-mortem in OKF format ready for Chapters.

INPUTS:
- Title: ${incidentTitle}
- Symptoms & Impact: ${symptoms}
- Root Cause: ${rootCause}
${affectedSymbols ? `- Affected Symbols: ${affectedSymbols}` : ''}

TEMPLATE:
---
type: incident
title: "Post-Mortem: ${incidentTitle}"
status: resolved
date: "${new Date().toISOString().slice(0, 10)}"
tags:
  - incident
  - post-mortem
---

# Post-Mortem: ${incidentTitle}

## 1. Executive Summary
${symptoms}

## 2. Impact & Timeline
- Start: ...
- Detection: ...
- Mitigation: ...
- Resolution: ...

## 3. Root Cause Analysis
${rootCause}

## 4. Contributing Factors
- ...

## 5. Preventative Action Items
- [ ] Add regression test in ...
- [ ] Add alert / monitoring for ...
- [ ] Update architecture spec in Chapters ...

Output the post-mortem note and offer to save it at \`incident/${slug}\`.`

      return {
        description: `Post-mortem: ${incidentTitle}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      }
    },
  )
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}
