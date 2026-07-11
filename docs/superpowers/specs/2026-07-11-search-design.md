# Chapters — Full-Text Search

Sub-project 4 of 6. Structural design only — no implementation detail.

## Depends on

- Sub-project 1 (Auth & Vault/Sharing model): every search query is scoped
  by the caller's live effective permissions, using the same access
  resolution rule — a note only appears in results for users who can
  currently reach its vault.
- Sub-project 2 (Editor): notes and their frontmatter/body are the raw
  material indexed here.
- Sub-project 3 (Graph engine & view): reuses the same embedding index
  (one embedding per note, computed at save-time) rather than building a
  second embedding pipeline.

## Goals

- Core v1 feature: let a user find notes by keyword or by meaning within a
  vault, or across every vault they can access.
- Serve both the human search UI and MCP/AI queries from one shared search
  path, so results and ranking never diverge between the two.
- Optimize for recall as well as speed — an AI assistant querying this
  index must not miss relevant notes just because they used different
  wording than the note.

## Index

- **Granularity**: whole note. Each note is one searchable unit — a match
  returns the note plus a highlighted snippet showing why it matched. This
  matches how the Editor and Graph engine already treat notes as the
  atomic unit; chunk-level (paragraph/section) indexing is deferred (see
  Out of scope).
- **Fields covered**: note title/path (e.g. `people/john-doe`), every
  frontmatter value (`type`, `resource`, `tags`, `timestamp`, and any
  extensible OKF keys), and the markdown body. Together this is the
  entire textual content of a note — nothing is excluded from the index.
- **Embeddings**: reuses the embedding index from sub-project 3 (recomputed
  whenever a note's body or frontmatter changes, per that spec). No
  separate embedding computation happens here.

## Query

- **Hybrid retrieval**: every query runs two matches in parallel —
  - a keyword/full-text match against the indexed fields (catches exact
    terms, names, IDs, code snippets), and
  - a semantic similarity match against the embedding index (catches
    conceptually related notes even when they don't share vocabulary) —
  then merges both into one ranked result set. Neither mode alone
  satisfies the "AI shouldn't miss relevant data" requirement: keyword
  alone misses conceptual matches, semantic alone misses exact-term
  lookups.
- **Scope**:
  - Default: scoped to the vault currently open, matching the Graph
    engine's per-vault default.
  - Optional: a "search everywhere" mode across every vault the querying
    user currently has access to (owned, shared, or included in their
    merged graph view) — useful when the user doesn't remember which
    vault a note lives in.
- **Result shape**: note path, matching snippet, frontmatter, and a
  relevance score — the same shape regardless of caller.

## Consumers

- **One search function, two callers.** The human search UI and the
  MCP search tool (sub-project 6) both call the same underlying search
  path — same hybrid retrieval, same ranking, same result shape. There is
  no separate AI-optimized query mode; keeping one path avoids the two
  consumers' results silently diverging over time.
- **Permission enforcement is uniform**: every query, whether issued from
  the UI or through an MCP connection, is filtered by the caller's live
  effective permissions before results are returned — a search never
  surfaces a note the requester couldn't otherwise open.

## Explicitly out of scope for this sub-project

- **Chunk-level (paragraph/section) indexing** — v1 indexes whole notes
  only. Revisit if long notes make whole-note snippets insufficiently
  precise.
- **MCP tool definition itself** (the actual connection/token plumbing
  that exposes this search function to an AI assistant) — sub-project 6;
  this spec only defines the search function those tools will call.
- **Real-time index updates during collaborative editing** — sub-project 5's
  concern once multi-user live editing exists; this spec assumes the index
  updates on save, consistent with how the embedding index (sub-project 3)
  already updates.

## Assumptions carried forward (revisit if wrong)

- Merge/ranking strategy between keyword and semantic results (e.g.
  weighting, score normalization) is an implementation-time decision, not
  fixed here.
- "Search everywhere" mode is opt-in per query (a toggle/mode switch), not
  a separate default — per-vault stays the default entry point.
