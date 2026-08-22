# Graph Engineering Findings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Act on the two real defects a deep-research pass on graph engineering
surfaced in our graph and search subsystems, measure the one thing nobody has
measured, and formally close four tracked deferrals that the same research shows
we should never do.

**Origin:** A multi-agent research pass (2026-08-22) across five layers of graph
engineering — execution abstractions, storage engines, incremental maintenance,
knowledge-graph extraction, and graph-augmented retrieval — then applied against
this codebase. Most of it does not apply to us, which is itself the finding. See
[Decisions](#decisions-closing-tracked-deferrals) below.

**Scope:** Backend only. Two bug fixes (one correctness, one storage leak) that
belong in a single PR, and one profiling task. No new dependency, no new
subsystem, no schema redesign.

## Global Constraints

- `semanticEdges` is polymorphic over `(nodeType, nodeId)` and deliberately has
  no FK — cleanup is therefore explicit and must be written by hand in each
  delete path. Do not add an FK.
- Single-process architecture holds (see `docs/agents/implementation.md`). None
  of this work distributes anything.
- pnpm; strict TS; Vitest; root `pnpm lint` clean before each commit.
- README/STATE.md updated in the same PR per the standing rule.

---

### Task 1: Fix asymmetric semantic-edge destruction

**The bug.** `recomputeSemanticEdges()` in `server/src/search/semantic-edges.ts`
deletes *every* row where the node appears on **either** side:

```ts
or(
  and(eq(semanticEdges.nodeAType, nodeType), eq(semanticEdges.nodeAId, nodeId)),
  and(eq(semanticEdges.nodeBType, nodeType), eq(semanticEdges.nodeBId, nodeId)),
)
```

then reinserts only the edges derived from **this** node's own top-k.

kNN is asymmetric. Note B can hold A in its top-k while A does not hold B in
its. Editing A therefore destroys an edge that belonged to B, and B's
neighbourhood is never restored until B happens to be re-embedded. Nothing
fails, no test goes red, and the graph is quietly wrong forever after.

**The fix — store edges directed, read them undirected.** Stop pretending the
rows are undirected in storage:

- [ ] Migration: rekey `semanticEdges` on `(sourceType, sourceId, targetType, targetId)`.
- [ ] `recomputeSemanticEdges()` deletes **only by source** (`sourceType`/`sourceId` = this node), then inserts this node's top-k as source→target rows.
- [ ] Delete the canonical-ordering logic (the `` `${type}:${id}` < ... `` swap) entirely — it exists only to fake undirectedness.
- [ ] `assemble.ts` is unchanged: `addEdge()` already dedups both directions, and the `byId.has(a) && byId.has(b)` guard already filters both endpoints.

Net effect is a migration plus a deletion of code.

**Test that fails without the fix:** embed A and B such that B holds A in its
top-k but A does not hold B. Re-embed A. Assert B→A still exists.

---

### Task 2: Delete semantic edges on the two hard-delete paths

**The leak.** `semanticEdges` rows are written only by `semantic-edges.ts` and
read only by `graph/assemble.ts`. Nothing removes them when a node dies:

- `server/src/notes/store.ts` → `purgeNote()` deletes the note row and the trash file, and leaves its semantic edges behind.
- `server/src/repositories/store.ts` → `syncRepositoryFiles()` hard-deletes files whose paths vanished, and leaves their semantic edges behind.

**Severity: leak, not corruption.** `assemble.ts:220` guards with
`byId.has(edge.nodeAId) && byId.has(edge.nodeBId)`, so orphaned rows never
render. What accumulates is table size and per-request query cost — the
`semanticEdges` select at `assemble.ts:219` matches on `or(inArray(A), inArray(B))`
and scans the orphans on every graph build.

- [ ] Delete the node's semantic edges in `purgeNote()`.
- [ ] Delete the deleted files' semantic edges in `syncRepositoryFiles()`, in the same block as the `repositoryFiles` hard-delete.
- [ ] One test per path asserting no orphan rows survive.

Ship in the same PR as Task 1 — both are edge-lifecycle correctness and the
migration touches the same table.

---

### Task 3: Profile `buildGraph()`'s Louvain pass

`graph/assemble.ts:259-265` runs Louvain over the **entire** assembled graph on
**every request**, with no cache, against a stated 10k-note budget. Nobody has
ever profiled it.

- [ ] Measure `buildGraph()` wall time at 1k / 5k / 10k nodes, split between the four queries, the structural-edge pairwise loops, and the Louvain call.
- [ ] Record the numbers in `docs/agents/implementation.md`.
- [ ] **Do not optimize anything before this.** If Louvain is not the dominant cost, caching it is wasted work — the pairwise structural-edge loops are the other plausible culprit and they are already capped by `STRUCTURAL_GROUP_CAP`.

---

## Decisions — closing tracked deferrals

These are the research's more valuable output: four things we have been tracking
as future work that we should now record as decided against, with the reasoning,
so nobody re-opens them.

**Leiden over Louvain — close as won't-do.** Traag's guarantee is that Louvain
can emit *disconnected* communities. That matters when a community is fed to a
summarizer that will assert "these things belong together". We do not summarize
communities. `assemble.ts` uses the Louvain result for exactly one thing: an
integer on `GraphNode.community` that the client colours nodes by. A slightly
wrong colour grouping in a force-directed view is not a defect a user can name,
and nobody has ever ablated Louvain against Leiden on downstream quality. The
swap costs a day for an unmeasurable payoff. Remove from the deferral list in
`STATE.md` and from `implementation.md`'s "Leiden tracked as upgrade".

**A graph database — never.** The crossover between relational and traversal
engines is *depth*, not size. `buildGraph()` does no traversal at all: four
bounded queries, materialize, hand to the client. There is no reachability
query, no shortest path, no recursive CTE anywhere in the codebase. Neo4j, AGE,
or SQL/PGQ would buy nothing and cost the property the app is built on — one
datastore, one process, `docker compose up`. Even a future "how is this note
connected to that file" feature is 2–3 hops, where Postgres still wins.

**LLM-summarized communities (GraphRAG-style) — never.** GraphRAG-style indexing
runs roughly $62 per million document tokens against about $1 for contextual
embeddings, and Microsoft's own successor reproduces the retrieval quality at
~0.1% of that index cost. Our index cost is zero dollars and zero network calls:
`search/embeddings.ts` runs `bge-small-en-v1.5` locally via ONNX and
`graph/assemble.ts` contains no LLM. For a self-hostable app where the operator
pays the bill and the notes are not supposed to leave the box, local-only is not
a compromise, it is the position.

**Cross-file call-graph resolution — stays deferred, and the reason is now
concrete.** `repositories/import-resolution.ts` resolves relative specifiers
against known sibling paths and nothing else. Real call resolution needs
compiler-grade language information; our whole ingestion model is a shallow
clone with no build step. Buying call-graph edges means buying a build.

**RRF `k=60` — leave it alone.** `search/search.ts` fuses four ranked lists at
`RRF_K = 60`. Published sweeps put a better nominal value at k=20, but the same
work shows best-vs-worst parameter choice moves nDCG@10 by only ~5%, and tuned
weighted fusion needs ~40 in-domain labelled queries just to beat *untuned* RRF.
We have zero labelled queries and no way to get them from self-hosters.
`CANDIDATES = 30` is the more interesting knob — it is the retrieval window —
but tune it only against a real corpus that misses a result we can point at.

---

## What this plan deliberately does not contain

The research covered durable execution and checkpointing, incremental view
maintenance and differential dataflow, bi-temporal graphs, entity resolution for
LLM-built graphs, and graph query languages. None of it produced work for us.
Recording that here so the next person reading the research does not re-derive
the same negative result.
