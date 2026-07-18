# Chapters — Code Graph & Unified Search/MCP Integration

Sub-project 9. Structural design only — no implementation detail.
Builds on sub-project 8 (Repository ingestion & permissions): once file
content is arriving and stored, this spec defines what's derived from
it and how it joins the existing graph/search/MCP engines.

## Depends on

- Sub-project 8 (Repository ingestion & permissions): the `Repository`/
  `RepositoryFile` entities and access resolution this spec builds on.
- Sub-project 3 (Graph engine & view): this spec extends `buildGraph`
  to be polymorphic over notes and repository files rather than
  building a parallel graph engine.
- Sub-project 4 (Search): this spec extends the search function the
  same way — one function, now spanning two content types, still one
  path for every caller.
- Sub-project 6 (MCP integration): new tools and a new connection scope
  follow that spec's existing patterns exactly (live access resolution
  per call, scope hard-rejection, no caching across connections).

## Goals

- Give code the same structural understanding notes already get:
  explicit edges (imports), lightweight structural edges, and semantic
  edges — queryable by the identical graph/search functions the UI and
  MCP already use for notes.
- Let notes and code cross-reference each other directly.
- Extend MCP with code-aware tools, under the same scope-enforcement and
  live-permission rules already established.

## Extraction pipeline

Runs once per changed file, for every ingestion method from sub-project
8 (one pipeline, one source of truth):

- **Language detection** from file extension.
- **Tree-sitter parsing**, matched to the detected language, for
  languages with a grammar available. Files in unsupported languages are
  still indexed as searchable/embeddable rows — they just don't produce
  parsed edges. Ship with grammars for a handful of mature, common
  languages (TypeScript/JavaScript, Python, Go); the extractor is a
  pluggable per-language module so adding a language is additive, not a
  redesign.
- **Import edges**: statements resolved to actual file paths within the
  repository (relative and common alias patterns) — not regex/string
  matching, which misses re-exports and gets aliasing wrong often enough
  to make the resulting graph unreliable.
- **Declared symbols** ("contains" edges, borrowed from Graphify's
  edge-kind vocabulary): a file's top-level functions/classes/
  interfaces, with name and line range. Cheap — one file's own parse
  tree, no cross-file resolution — and gives sub-file navigation ("find
  this function") without the much larger scope of full call-graph
  resolution.
- **Embedding**: the same embedding index and save-time queue notes
  already use (sub-project 3), just a second producer writing into the
  same vector space. Whole-file granularity, matching the whole-note
  precedent — chunk-level code search is deferred, same as chunk-level
  note search was deferred in sub-project 4.

**Explicitly deferred**: cross-file call-graph resolution (which
function calls which, across files) — genuinely valuable, but close to
building a lightweight language server. Symbol declarations (cheap) ship
in v1; resolving references between them (expensive) does not.

## Graph integration

`buildGraph` (sub-project 3) takes a resource set — vault IDs *and*
repository IDs — instead of vault IDs alone. Node set is the union of
live notes and live repository files across that resource set.

Edge kinds, extending the existing EXTRACTED/INFERRED model:

- **EXTRACTED, existing**: note wikilinks, unchanged.
- **EXTRACTED, new**: code import edges (file → file, within one
  repository).
- **EXTRACTED, new — cross-type**: a new wikilink form,
  `[[repo:<repository-name>/<path>]]`, lets a note link directly into a
  specific file, resolved against whatever repositories the caller can
  currently reach. This is the concrete mechanism behind "notes and code
  cross-reference each other."
- **INFERRED structural, existing**: shared note type/tag, unchanged.
- **INFERRED structural, new**: same top-level directory or same
  language between two files — a cheap, capped signal (reusing the
  existing structural-edge group-cap mechanism), not a new concept.
- **INFERRED semantic**: no new mechanism needed. Notes and code already
  share one embedding model and one vector space (see above) — semantic
  similarity edges between a design note and the code it describes fall
  out of the existing per-note-or-file KNN neighbor search automatically,
  once both content types are embedded into it.

**Symbols are not first-class graph nodes** in the main graph view —
exposing every function/class as a node would make a large codebase's
graph unreadably dense, the same concern that already motivated
group-capping structural note edges. Declared symbols are instead
queryable per-file (an "outline" for a given path) rather than rendered
in the main graph.

Louvain communities run over the unioned edge graph exactly as today —
this means a cluster can now span a note and the files it documents,
which is a direct, useful consequence of unification rather than a
feature that needed separate design.

## Search integration

The search function (sub-project 4) takes the same extended resource
set as the graph function. Hybrid retrieval extends symmetrically: full-
text search adds a `repository_files.fts` generated column (path +
code content) alongside the existing `notes.fts`; vector KNN already
spans both once both are embedded into the same space. Results merge via
the same Reciprocal Rank Fusion approach already used for notes-only
search — one function, one ranking approach, now two content types,
still the same "one search path for every caller" rule from sub-project
4 (unchanged, just a larger input domain).

## MCP integration

New tools, added under the same rules sub-project 6 already established
(every call re-resolves live access; account-wide surfaces hard-rejected
for narrower-scoped connections, never silently narrowed):

- **`list_repositories`** — parallel to `list_vaults`; account-scoped
  connections only.
- **`browse_repository`** — a repository's file tree.
- **`read_file`** — a file's content plus its declared-symbol outline.
- **`search`** and **`graph`** (existing tools) extend to accept
  repository IDs alongside vault IDs — same tools, larger domain, no new
  tool needed.
- **`repository_status`** — last-synced time and sync state, so an agent
  can judge freshness before trusting results, given sync isn't
  necessarily instantaneous (polling fallback, agent-push cadence).

**No write/delete/revert tools for repository files** — consistent with
sub-project 8's read-only boundary. There is no audit trail to expose
here because there is nothing to attribute; git remains the record of
change history for code.

### Connection scope

`MCPConnection.scope` gains a `repository` value alongside the existing
`account`/`vault`, with a nullable `repositoryId` paired the same way
`vaultId` already is. A repository-scoped connection is pinned to one
repository and hard-rejected from every other surface (other
repositories, vaults, account-wide tools) — identical enforcement
posture to vault-scoped connections today. Account-scoped connections
resolve live to whatever vaults *and* repositories the owning user
currently has access to.

## Explicitly out of scope for this sub-project

- **Cross-file call-graph resolution** — see extraction pipeline above.
- **Symbol-level embeddings / chunk-level code search** — file-level
  granularity for v1, matching the notes precedent.
- **Rendering symbols in the graph view** — outline-on-demand instead;
  see graph integration above.
- **Editing code through Chapters** — sub-project 8's boundary, unchanged
  here.

## Assumptions carried forward (revisit if wrong)

- Which languages ship a tree-sitter grammar at launch is an
  implementation-time decision — the extractor's pluggability is the
  requirement, not a fixed language list.
- The `repo:` prefix disambiguating cross-type wikilinks from plain note
  links is a convention, not a protocol requirement — exact syntax is an
  implementation-time detail as long as it's unambiguous against the
  existing `[[type/name]]` note-link form.
- Structural edge thresholds (directory/language grouping cap) reuse
  the existing note structural-edge cap value unless profiling suggests
  otherwise.
