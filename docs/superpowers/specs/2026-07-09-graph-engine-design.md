# Chapters — Graph Engine & View

Sub-project 3 of 6. Structural design only — no implementation detail.

## Depends on

- Sub-project 1 (Auth & Vault/Sharing model): graph visibility follows the
  same access resolution rule — a note only appears in a graph for users
  who can access its vault. The merged cross-vault view is gated by
  `Vault.mergeable` and each user's `VaultGraphPreference`.
- Sub-project 2 (Editor): notes and their `[[wikilinks]]`/frontmatter are
  the raw material this sub-project indexes and visualizes. The link index
  built here also powers the backlinks panel deferred from the Editor spec.

## Shares a dependency with sub-project 4 (Search)

Both this sub-project's semantic INFERRED edges and sub-project 4's
AI-accurate search rely on the same **embedding index**: one embedding
computed per note at save-time, stored once, reused by both. This is a
deliberate shared building block, not duplicated work — and computing
embeddings at save-time (rather than per query) means no per-query LLM
calls, which keeps graph rendering and search both fast and avoids sending
note content to an external API on every interaction.

## Goals

- Build a queryable knowledge graph per vault, in the OKF/Graphify-inspired
  style: explicit vs inferred relationships, automatic community detection.
- Let a user visually explore a vault's graph, with real customization —
  clustering mode, filtering, physics, appearance — not fixed defaults.
- Support an opt-in merged view spanning every vault a user has connected
  to their personal graph, with real cross-vault edges.

## Graph engine (data layer)

### Edge types

- **EXTRACTED** — explicit `[[wikilinks]]`, found by scanning notes
  vault-wide. This is the same link index the Editor sub-project's
  backlinks panel reads from — built once here, consumed there.
- **INFERRED**, two tiers:
  - **Structural** — two notes share a `type` or have overlapping `tags`.
    Computed directly from OKF frontmatter; no AI involved, cheap to
    recompute whenever frontmatter changes.
  - **Semantic** — two notes are related by meaning even without shared
    links, type, or tags. Derived from the shared embedding index (see
    above): notes whose embeddings are sufficiently similar get a semantic
    inferred edge.

### Community detection

- Leiden algorithm run over the full edge graph (extracted + both inferred
  tiers) to detect natural groupings/subsystems within a vault, independent
  of how the user manually typed/tagged things.

## Graph view (UI layer)

### Scope

- **Per-vault by default**: opening a vault shows that vault's graph only.
- **Merged view**: a separate, opt-in view combining every vault the
  current user has marked via `VaultGraphPreference` (and whose owner has
  `mergeable` on, per sub-project 1). Cross-vault relationships (a link,
  shared type/tag, or semantic similarity between notes in *different*
  merged vaults) draw a real edge — the point of merging vaults is one
  interconnected graph, not several side-by-side ones.

### Coloring modes

- **By type/tag** (manual): node color reflects the OKF `type` or a chosen
  tag — shows how the user organized things.
- **By detected community** (Leiden): node color reflects automatic
  clustering — shows how the vault is actually structured.
- Only one mode active at a time, switchable via a toggle — layering both
  was considered and rejected for this sub-project to keep the view
  readable.

### Filtering

- Filter panel scoped by `type`, `tags`, and date range (`timestamp`
  frontmatter), live-updating which nodes/edges are shown.

### Physics & appearance

- Exposed, adjustable controls (not hidden fixed defaults): force
  strength, link distance, clustering tightness, plus cosmetic controls
  (node size, color palette, edge styling).

## Explicitly out of scope for this sub-project

- **Full-text search UI** — sub-project 4, though it shares the embedding
  index built here.
- **Real-time collaborative graph updates** (e.g. live-updating as a
  teammate edits) — sub-project 5's concern once collaborative editing
  exists; this sub-project assumes the graph reflects the vault's saved
  state.
- **MCP-exposed graph queries** — sub-project 6 wraps this engine for AI
  access; this spec only covers the engine and its human-facing view.

## Assumptions carried forward (revisit if wrong)

- Semantic similarity threshold for creating an inferred edge is a tunable
  parameter, not fixed — exact value decided at implementation time.
- Embeddings are recomputed whenever a note's body or frontmatter changes,
  not on a schedule — keeps the graph consistent with the latest save
  without a separate reindexing job to manage.
- Community detection (Leiden) reruns whenever the underlying edge graph
  changes meaningfully, not on every single edit — exact recompute
  trigger/frequency is an implementation-time decision.
