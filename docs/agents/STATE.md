# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: **UI phase DONE** — all 7 units of
  `specs/2026-08-22-remaining-ui-design.md` shipped. PRs target `dev` directly,
  never stacked; `dev → prod` needs Taha's explicit OK each time. Backend
  complete + ~16 UI-driven additions. `pnpm profile-graph` ≈500ms at 10k notes,
  **Louvain NOT the bottleneck**; semantic edges **directed** (purges clear
  them, no FK).
- **Units 1–7 shipped.** Detail in README + git log; only the traps live here:
  - **1** Louvain is **seeded** — drill-down addresses communities by number.
  - **3** `/admin` is gated *before* any query fires, **metadata only**;
    **login stays generic on purpose** (account enumeration).
  - **4** **per-type notification prefs stay OUT of scope.**
  - **5** `actorType` is `user|mcp|collab`, no 'system'; **collab is a PERSON**
    and is the commonest. `/history/*` metadata-only — **MCP `note_history`
    deliberately untouched**.
  - **6** **no autosave PUT** — the CRDT is the note. `/collab/ticket` returns
    a **path**: behind any proxy the server's `host` is the proxy's.
    **revoked ≠ offline** — revoked KEEPS the doc (unsent text must survive).
  - **7** viewer read-only forever; local folders watched;
    **`gitUrl`/`localPath` are owner-only** (they leaked to viewers + MCP).
- **Phase: DEPLOYABLE** (`plans/2026-08-27-deployable.md`). UI phase complete;
  the product still cannot be run by anyone — nothing serves the client,
  compose is Postgres alone, `/collab` is routed nowhere.
- **Hosted = one container + one Postgres PER CUSTOMER**, and the app is **not
  forked** for it: one repo, one branch line; the control plane is a separate
  private repo the app must NEVER import or call. No edition flag — it would
  branch on nothing. See `implementation.md` "Product shape".
- **Current task**: sign-in path (PR open). Next: serve client from the API +
  single-port `/collab` + a real image and compose.
- **Mutation-verify every new test** AND click it in a real browser. Two whole
  features shipped green and broken: `apiFetch` sent JSON with no body (#110),
  and unit 6's ticket built its ws URL from fastify's `host`, which is the
  proxy's — 537 tests passed while every editor 404'd the handshake.
- **Deferred**: cloud backups, cli-visualizer (#9), symbol embeddings, partial
  restore, single-process arch. **Decided against 2026-08-22, do NOT re-open**:
  Leiden, a graph DB, GraphRAG summaries, cross-file calls.
- **Open issues**: #9; #101 (graph query-params, dead overload, dangling
  notifications on purge). #66 is closed by unit 6's CRDT. **Test-that-cannot-
  fail: SEVEN times**, always a fixture too uniform to tell working from broken.
