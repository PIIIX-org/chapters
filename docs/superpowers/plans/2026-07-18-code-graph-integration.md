# Code Graph & Unified Search/MCP Integration Implementation Plan

> **For agentic workers:** Executed inline in the same session, same
> conventions as `docs/superpowers/plans/2026-07-18-repository-ingestion.md`
> (full context, single implementer, no subagent dispatch).

**Goal:** Give repository files the same structural understanding notes
already get (explicit/structural/semantic edges, hybrid search), through
the *same* graph/search/MCP functions the UI and MCP already use for
notes — not a parallel engine.

**Architecture:** `buildGraph` and `searchNotes` extend their resource
parameter from `vaultIds: string[]` to `{vaultIds, repositoryIds}`. A
tree-sitter extraction pipeline (mirroring the existing embedding
queue's off-request-path pattern) derives import edges and top-level
symbol declarations per file. Notes and code share one embedding model
already, so semantic cross-type edges require no new machinery.

**Tech Stack:** `tree-sitter` + `tree-sitter-typescript`,
`tree-sitter-python`, `tree-sitter-go` (native bindings — same
already-proven native-build pattern as `onnxruntime-node`/`sharp` in
this repo).

## Global Constraints

- Extraction and embedding never run on the sync request path (perf
  rule) — queued, same posture as the existing note embedding queue.
- Symbols are not first-class graph nodes (would make large-repo graphs
  unreadable) — queryable per-file only.
- No cross-file call-graph resolution (explicitly deferred in the spec).
- `buildGraph`/`searchNotes` stay the single path for both UI and MCP —
  no second, MCP-only implementation.
- MCP repository-scoped connections are hard-rejected from every other
  surface, same posture as vault-scoped connections today.

---

## File structure

```
server/src/
├── db/schema.ts                       # + repositoryFileImports, repositoryFileSymbols,
│                                       #   repositoryFiles.embedding, repositoryFiles.fts,
│                                       #   mcpScope 'repository', mcpConnections.repositoryId
├── repositories/
│   ├── extraction.ts                  # tree-sitter: per-language import/symbol extraction
│   ├── extraction-queue.ts            # async queue: extraction + embedding, off request path
│   ├── store.ts                       # MODIFY: schedule extraction on create/update
│   └── routes.ts                      # + GET :id/graph, GET :id/search (repo-only views)
├── graph/assemble.ts                  # MODIFY: buildGraph over {vaultIds, repositoryIds}
├── graph/routes.ts                    # MODIFY: pass repositoryIds through; extend /graph/merged
├── search/search.ts                   # MODIFY: searchNotes over {vaultIds, repositoryIds}
├── search/routes.ts                   # MODIFY: pass repositoryIds through; extend /search
├── vaults/mcp-connection-routes.ts    # MODIFY: accept scope: 'repository' + repositoryId
└── mcp/server.ts                      # MODIFY: repository-aware tool scope resolution;
                                        #   + list_repositories, browse_repository, read_file,
                                        #   repository_status
```

## Interfaces (so later tasks match earlier ones exactly)

```ts
// repositories/extraction.ts
export type SymbolKind = 'function' | 'class' | 'interface' | 'type'
export interface ExtractedSymbol {
  name: string
  kind: SymbolKind
  startLine: number
  endLine: number
}
export interface ExtractionResult {
  imports: string[] // raw import specifiers, unresolved
  symbols: ExtractedSymbol[]
}
export function isSupportedLanguage(language: string | null): language is 'typescript' | 'javascript' | 'python' | 'go'
export function extractStructure(language: string, content: string): ExtractionResult

// repositories/extraction-queue.ts
export function scheduleExtraction(fileId: string): void
export async function flushExtraction(): Promise<void> // tests only, mirrors flushEmbeddings

// graph/assemble.ts
export interface GraphResourceSet {
  vaultIds: string[]
  repositoryIds: string[]
}
export interface GraphNode {
  id: string
  resourceType: 'note' | 'code'
  resourceId: string // vaultId or repositoryId
  path: string
  type: string | null // note OKF type, or detected language for code
  tags: string[] // notes only, empty for code
  timestamp: string | null // notes only, null for code
  community: number
}
export async function buildGraph(resources: GraphResourceSet, filters?: GraphFilters): Promise<VaultGraph>
// GraphEdge, VaultGraph, GraphFilters, cappedGroups unchanged in shape

// search/search.ts
export interface SearchResourceSet {
  vaultIds: string[]
  repositoryIds: string[]
}
export interface SearchResult {
  resourceType: 'note' | 'code'
  id: string // noteId or repositoryFileId
  containerId: string // vaultId or repositoryId
  path: string
  frontmatter?: unknown // notes only
  language?: string | null // code only
  snippet: string
  score: number
}
export async function searchNotes(resources: SearchResourceSet, query: string, limit?: number): Promise<SearchResult[]>
```

`buildGraph`/`searchNotes` keep their names (established precedent:
extend the signature, don't rename already-shipped, tested functions)
but their first parameter's shape changes — every existing call site
(`graph/routes.ts`, `search/routes.ts`, `mcp/server.ts`) is updated in
the same task that changes the signature, never left half-migrated.

## Tasks

### Task 1: Schema

**Files:** Modify `server/src/db/schema.ts`; generate migration.

- `repositoryFiles` gains `embedding` (`vector(384)`, same shared index
  as notes) and a generated `fts` tsvector column (path + content),
  GIN-indexed and HNSW-indexed — identical pattern to `notes`'
  equivalent columns (added by hand-editing the generated migration
  SQL, same as sub-projects 3+4 did for `notes.fts`/`notes.embedding`).
- `repositoryFileImports`: `sourceFileId` (→ repositoryFiles, cascade),
  `targetPath` (raw, unresolved), `resolvedTargetFileId` (nullable, →
  repositoryFiles). Mirrors `noteLinks`' shape.
- `repositoryFileSymbols`: `id`, `fileId` (→ repositoryFiles, cascade),
  `name`, `kind`, `startLine`, `endLine`.
- `mcpScope` enum gains `'repository'`; `mcpConnections` gains a
  nullable `repositoryId` (→ repositories, cascade) alongside the
  existing nullable `vaultId`.

- [ ] Add the tables/columns/enum value to `schema.ts`.
- [ ] `pnpm db:generate`; hand-edit the generated SQL to add the
      `CREATE EXTENSION IF NOT EXISTS vector` (if not already present),
      the `fts` generated column, and the GIN/HNSW indexes — same
      pattern as `0002_lean_living_lightning.sql`.
- [ ] `pnpm typecheck`, confirm clean.
- [ ] Commit.

### Task 2: Tree-sitter extraction core

**Files:** Create `server/src/repositories/extraction.ts`; Test:
`server/test/extraction.test.ts`.

**Produces:** `extractStructure`, `isSupportedLanguage` — consumed by
Task 3.

- [ ] Write failing tests against real snippets for all three
      languages:
      - TypeScript: `import { x } from './a'` + `import y from '../b'`
        → `imports: ['./a', '../b']`; a top-level `export function foo() {}`
        and `export class Bar {}` → symbols `[{name:'foo',kind:'function',...}, {name:'Bar',kind:'class',...}]`
        with correct 1-indexed `startLine`/`endLine`.
      - Python: `import os` + `from .utils import helper` →
        `imports: ['os', '.utils']`; `def foo():` and `class Bar:` at
        module level → matching symbols.
      - Go: `import "fmt"` and a grouped `import (...)` block → all
        import paths extracted; `func Foo() {}` and `type Bar struct{}`
        → matching symbols.
      - `isSupportedLanguage(null)` and an unrecognized language string
        both return `false`; `extractStructure` on an unsupported
        language throws (callers must check `isSupportedLanguage` first).
- [ ] Implement: one `Parser` + language grammar per supported
      language, instantiated once at module load (not per call — parser
      construction isn't free). Tree-sitter query strings per language,
      one for import statements, one for top-level declarations, run
      via `Query.matches(tree.rootNode)`.
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 3: Extraction queue

**Files:** Create `server/src/repositories/extraction-queue.ts`; Test:
`server/test/extraction-queue.test.ts`. Modify
`server/src/repositories/store.ts` to call `scheduleExtraction` after
create/update (mirroring exactly how `notes/store.ts` calls
`scheduleEmbedding`).

**Consumes:** `extractStructure`, `isSupportedLanguage` (Task 2), the
existing `embedder` (`search/embeddings.ts` — reused unmodified, code
and notes share one embedding pipeline).
**Produces:** `scheduleExtraction`, `flushExtraction`.

- [ ] Write failing tests: scheduling extraction for a TypeScript file
      with an import and a function, after `flushExtraction()`,
      produces the expected `repositoryFileImports` and
      `repositoryFileSymbols` rows, and a non-null `embedding` on the
      file; an unsupported-language file gets an embedding but no
      import/symbol rows (graceful degradation per the spec); resyncing
      an unchanged file (same content hash — `store.ts` already skips
      the write in that case) never re-triggers extraction, since
      `scheduleExtraction` is only called from the create/update
      branches, not the no-op branch.
- [ ] Implement: in-process serial queue (same shape as
      `embedding-queue.ts`), per file: run `extractStructure` if
      `isSupportedLanguage`, replace that file's
      `repositoryFileImports` rows with the raw import targets
      (`resolvedTargetFileId` filled in by matching against
      `repositoryFiles` in the same repository — same relative-path
      resolution style as `noteLinks`), replace its
      `repositoryFileSymbols` rows, then embed
      `${path}\n${content}` and store it.
- [ ] Wire `scheduleExtraction(file.id)` into `syncRepositoryFiles`'
      create and update branches (not the unchanged/no-op branch).
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 4: Graph engine polymorphism

**Files:** Modify `server/src/graph/assemble.ts`,
`server/src/graph/routes.ts`. Test: extend
`server/test/graph-search.test.ts` (or a new
`server/test/repository-graph.test.ts` if the existing file is better
left notes-only — decide by which reads more clearly; either is fine).

**Consumes:** `repositoryFiles`, `repositoryFileImports`,
`repositoryFileSymbols` (Tasks 1–3), `resolveRepositoryAccess`
(sub-project 8).
**Produces:** the extended `buildGraph` signature every later graph
task and route relies on.

- [ ] Write failing tests: a graph built over `{vaultIds: [], repositoryIds: [repoId]}`
      includes code file nodes with `resourceType: 'code'`; an import
      edge between two files in the same repository resolves and
      appears with `kind: 'extracted'`; two files in the same top-level
      directory get a `kind: 'structural'` edge; two files (or a file
      and a note) with similar embedded content get a `kind: 'semantic'`
      edge (reusing the fake test embedder's bag-of-words behavior, same
      technique `graph-search.test.ts` already uses); Louvain
      communities are assigned across the unioned node set; a mixed
      `{vaultIds, repositoryIds}` call returns nodes from both.
- [ ] Implement: `buildGraph` takes `GraphResourceSet`; node query
      becomes two queries (notes scoped by `vaultIds`, repository files
      scoped by `repositoryIds`) merged into one `GraphNode[]`; extracted
      edges add a second source (`repositoryFileImports`, resolved
      target within the same repo); structural edges add a
      same-top-level-directory and same-language grouping for code
      nodes (reusing the existing group-cap mechanism, not a new one);
      semantic edges already span both once both have embeddings (no
      new query — the existing KNN-over-`notes.embedding` neighbor
      logic needs to also scan `repositoryFiles.embedding` for
      candidates, since it was previously stored per-note-only via
      `semanticEdges`; extend that table's producer, sub-project 3+4's
      embedding queue path, isn't touched — instead compute cross-type
      semantic edges directly in `buildGraph` via a KNN query restricted
      to the current node set, since `semanticEdges` was built assuming
      notes-only IDs and repository files use a different ID space).
- [ ] Update `graph/routes.ts`'s two call sites
      (`buildGraph([req.params.id], ...)` → `buildGraph({vaultIds: [req.params.id], repositoryIds: []}, ...)`,
      and the merged-view call) to the new shape.
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 5: `repo:` wikilink cross-type resolution

**Files:** Modify `server/src/graph/assemble.ts`. Test: extend the
graph test file from Task 4.

**Consumes:** the extended `buildGraph` (Task 4), `listAccessibleRepositories`
(sub-project 8, for resolving a repository name to an ID within the
caller's own resource set — resolution only ever considers repositories
already included in this `buildGraph` call's `repositoryIds`, never a
wider lookup).

- [ ] Write a failing test: a note body containing
      `[[repo:my-repo/src/auth.ts]]`, when `buildGraph` is called with
      both the note's vault and a repository named `my-repo` in its
      resource set, produces an `extracted` edge between the note and
      that file. If the repository isn't in the current resource set
      (not accessible / not included), no edge is produced and nothing
      throws.
- [ ] Implement: when resolving a note's `noteLinks` targets, if a
      target starts with `repo:`, split into repository name + path,
      look up the repository by name among the repositories already
      loaded for this graph call (not a fresh DB query — the resource
      set was already resolved), then look up that repository's file
      by path within the already-loaded repository file node set; add
      the edge if both resolve.
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 6: Search unification

**Files:** Modify `server/src/search/search.ts`,
`server/src/search/routes.ts`. Test: extend
`server/test/graph-search.test.ts`.

**Produces:** the extended `searchNotes` every later search task and
route relies on.

- [ ] Write failing tests: a query matching code content (keyword)
      returns a result with `resourceType: 'code'` and the file's path;
      a query matching a note by keyword still returns `resourceType: 'note'`
      results, unchanged from before; a single query can return both
      kinds merged into one ranked list; permission boundary — a
      repository not in the resource set never appears (mirrors the
      existing notes leakage test).
- [ ] Implement: `searchNotes` takes `SearchResourceSet`; the FTS query
      becomes a `UNION ALL` across `notes` and `repositoryFiles` (each
      already has its own `fts` column per Task 1), the vector KNN
      query similarly unions both tables' `embedding` columns; RRF
      merge logic is unchanged (it already operates on an opaque row
      id/score, doesn't care which table a row came from) — just needs
      each result tagged with `resourceType`/`containerId` instead of
      the note-only `vaultId`.
- [ ] Update `search/routes.ts`'s two call sites to the new resource-set
      shape.
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 7: Repository-scoped and merged REST routes

**Files:** Modify `server/src/repositories/routes.ts` (add),
`server/src/graph/routes.ts` (extend merged view),
`server/src/search/routes.ts` (extend everywhere view). Test: extend
`server/test/repository-routes.test.ts`.

**Consumes:** `buildGraph`, `searchNotes` (Tasks 4/6),
`listAccessibleRepositories` + repository graph preferences
(sub-project 8).

- `GET /repositories/:id/graph` — single-repository view, mirrors
  `GET /vaults/:id/graph`'s permission guard (`resolveRepositoryAccess`
  ≥ viewer).
- `GET /repositories/:id/search?q=` — same pattern.
- `GET /graph/merged` — extend to also include every repository the
  caller has opted into via `RepositoryGraphPreference` (same
  preference ∩ mergeable ∩ live-access rule sub-project 8 already
  established for repositories, just now actually feeding into the
  merged graph rather than sitting unused).
- `GET /search` (everywhere) — extend to include every repository the
  caller currently has any access to (mirrors how it already includes
  every accessible vault, not just mergeable-gated ones — "search
  everywhere" and "merge into my graph" are deliberately different
  scopes, per the original search/graph specs).

- [ ] Write failing tests: repo-only graph/search endpoints work and
      are permission-gated; merged graph includes an opted-in
      repository's nodes; "search everywhere" finds a result in a
      repository the caller has any access to (not gated by the
      mergeable/preference flags, matching the vault precedent).
- [ ] Implement the four route changes.
- [ ] Run tests, confirm green.
- [ ] Commit.

### Task 8: MCP repository tools and scope

**Files:** Modify `server/src/db/schema.ts` (already done in Task 1 —
this task just uses the new enum value/column), `server/src/vaults/mcp-connection-routes.ts`,
`server/src/mcp/server.ts`. Test: extend `server/test/mcp.test.ts`.

**Consumes:** everything above; `resolveRepositoryAccess` (sub-project
8).

- [ ] Write failing tests: creating an MCP connection with
      `scope: 'repository', repositoryId` succeeds only if the caller
      has access to that repository (mirrors the existing vault-scope
      creation guard); `list_repositories` works for account-scoped
      connections and is hard-rejected (not narrowed) for both
      vault-scoped and repository-scoped connections; `browse_repository`
      and `read_file` work for repository-scoped and account-scoped
      connections, gated by live access; `read_file`'s response
      includes the file's declared-symbol outline (from
      `repositoryFileSymbols`); `search`/`graph` tools accept a
      `repositoryId` argument alongside the existing `vaultId`; a
      repository-scoped connection calling `read_file`/`browse_repository`
      for a *different* repository is rejected; `repository_status`
      returns `lastSyncedAt`/`syncStatus`.
- [ ] Implement: extend `mcp-connection-routes.ts`'s creation validation
      for the new scope (mirrors the existing `scope === 'vault'`
      branch); extend `mcp/server.ts`'s `vaultFor`-equivalent resolution
      to also handle `repositoryFor(requested?: string)` with the same
      hard-scope-rejection logic; register the four new tools
      (`list_repositories`, `browse_repository`, `read_file`,
      `repository_status`); extend the existing `search`/`graph` tools'
      input schemas and handlers to build a `GraphResourceSet`/
      `SearchResourceSet` instead of a single vault ID.
- [ ] Run tests, confirm green.
- [ ] Commit.

## Self-review

**Spec coverage:** Extraction pipeline (language detection, tree-sitter
import/symbol edges, graceful degradation for unsupported languages,
deferred call-graph resolution) — Tasks 2–3. Graph polymorphism
(EXTRACTED code imports, structural directory/language grouping,
semantic edges spanning both, symbols not first-class nodes, Louvain
over the union) — Task 4. `repo:` cross-type wikilinks — Task 5. Search
unification (one function, RRF unchanged, permission boundary) — Task
6. MCP tools + hard-scoped `repository` connection type, no write/
delete/revert tools anywhere — Task 8.

**Placeholder scan:** No TBD/TODO; every task names exact files and
either shows the interface or the concrete test behavior expected.

**Type consistency:** `GraphResourceSet`/`SearchResourceSet`,
`GraphNode`, `SearchResult` defined once in Interfaces and referenced
identically in every task that touches them; `ExtractionResult`/
`ExtractedSymbol`/`SymbolKind` likewise.

**Gap check against the spec:** the spec's assumptions section marks
the exact `repo:` syntax and the launch language list as
implementation-time decisions — both are resolved concretely above
(the `repo:` prefix as specced; TypeScript/JavaScript/Python/Go as the
launch set, matching the tech-stack rationale for a TS-first,
AI-navigable platform).
