# Plan — Sub-projects 3+4: Graph engine + Search (backend)

Specs: `2026-07-09-graph-engine-design.md`, `2026-07-11-search-design.md`.
Built together because both consume the one shared embedding index.

## Implementation-time decisions

- **Embedder interface** (`search/embeddings.ts`): `embed(texts) →
  number[][]`, fixed 384 dims (pgvector column is dimension-fixed).
  Implementations: `local` — bge-small-en-v1.5 via Transformers.js ONNX,
  lazy-loaded, note content never leaves the instance; `fake` —
  deterministic bag-of-words hash vectors for tests/dev (similar texts →
  similar vectors, so semantic behavior is actually testable). Selected
  by `EMBEDDINGS` env (default: local in production, fake otherwise).
  Switching embedders requires re-embedding (same dims, different space).
- **Save-time, off the request path** (perf rule 2): note writes enqueue
  into an in-process serial embedding queue; a save never waits. Queue
  work per note: embed → store vector → recompute that note's semantic
  edges (one KNN query, top-K=8, cosine similarity ≥ threshold 0.75 —
  both env-tunable, per the spec's "tunable, decided at implementation
  time"). `flush()` drains it for tests.
  <!-- ponytail: in-process queue; move to a job table if multi-process -->
- **Edge storage**:
  - EXTRACTED → `note_links` rows (source note id → target path),
    replaced on every save from the body's wikilinks.
  - Semantic INFERRED → `semantic_edges` (a,b ordered pair + similarity),
    maintained by the queue. KNN is deliberately **not** vault-restricted
    — cross-vault semantic edges fall out for free; permission filtering
    happens at query time against the caller's live vault set, never at
    storage time.
  - Structural INFERRED (shared type / overlapping tags) → computed at
    query time in TS from live frontmatter; no table.
- **Communities**: Louvain (graphology) computed per request over the
  assembled edge graph. No cross-request cache in v1 — honors sub-project
  6's no-shared-cache rule by not caching at all.
  <!-- ponytail: per-request Louvain; add per-connection-scoped cache if graph latency matters -->
- **Merged graph**: candidate vaults = user's graph preferences ∩ owner
  `mergeable` ∩ live access re-resolved per request (audit rule). Same
  assembly, multi-vault note set; cross-vault edges appear naturally.
- **Search**: one `searchNotes()` function for every caller (UI now, MCP
  later). Hybrid = Postgres FTS (`websearch_to_tsquery` on a generated
  stored `fts` tsvector column over path+frontmatter+body, GIN-indexed)
  merged with pgvector KNN on the query's embedding via Reciprocal Rank
  Fusion (rank-based, no score normalization to tune). Snippets via
  `ts_headline`, falling back to a body slice for semantic-only hits.
  Permission filter (`vault_id IN accessible`) applied **inside** the SQL
  — absence of access is absence from the result set, no counts, no
  hints. Soft-deleted notes excluded everywhere.

## Endpoints

- `GET /vaults/:id/graph?types=&tags=&since=&until=` (read) —
  nodes (path/type/tags/community) + typed edges
- `GET /graph/merged` — merged multi-vault graph per the live-access rule
- `GET /vaults/:id/search?q=` (read) — vault-scoped hybrid search
- `GET /search?q=` — "search everywhere" across accessible vaults

## Tasks

1. Migration: `vector` extension, `embedding vector(384)` + HNSW index,
   `fts` generated column + GIN, `note_links`, `semantic_edges`.
2. Embedder (fake+local) + queue; wire into `notes/store.ts` writes.
3. Graph assembly (extracted/structural/semantic + Louvain) + endpoints.
4. `searchNotes()` + endpoints; leakage tests (stranger sees nothing,
   revocation takes effect immediately).
