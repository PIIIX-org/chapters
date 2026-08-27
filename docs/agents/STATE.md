# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI, executing `specs/2026-08-22-remaining-ui-design.md` (10 locked
  decisions, 7 units). **PRs target `dev` directly, never stacked.** Promotion
  `dev → prod` needs Taha's explicit OK each time. Backend complete + twelve
  UI-driven additions; `pnpm profile-graph` ≈500ms at 10k notes, **Louvain NOT
  the bottleneck**; semantic edges stored **directed** (purges clear them, no FK).
- **Units 1–6 shipped** (detail in README + git log):
  - **1** graph Home (Canvas 2D + `d3-force`), shell, vault lifecycle, ⌘K.
    **Louvain is seeded** — drill-down addresses communities by number.
  - **2** vault settings modal stack, `/team`; `/users/lookup` exact-match,
    `/teams/:id/stats` aggregates only.
  - **3** `/admin` — admins only, gated *before* any query fires, **metadata
    only**; **login stays generic on purpose** (enumeration).  - **4** `/settings`: TOTP (codes once), change email/password, ONE
    notification-email switch, account `McpPanel`, account export. Admin can
    mandate MFA. **Per-type notification prefs stay OUT of scope.**
  - **5** note trash + restore, vault purge, Editor history rail (revert = a NEW
    attributed revision; owner-only revision purge), import (ALWAYS a new
    vault). Paginated `/history/*` (metadata only — **MCP `note_history`
    deliberately untouched**) and `/trash`. `actorType` is `user|mcp|collab`,
    no 'system'; **collab is a PERSON** (vermillion) and is the commonest.
  - **6** collaboration: one Yjs doc per note over the existing relay, **no
    autosave PUT** (the CRDT is the note — closes #66), pen-nib carets in five
    inks, presence in the Editor top bar only, SSE live view for readers.
    `POST /collab/ticket` returns a **path**, not a URL — behind any proxy the
    server's `host` is the proxy's, so the browser resolves it.
    **revoked ≠ offline**: revoked locks and KEEPS the doc (unsent text must
    survive); offline shows the last saved copy read-only and retries.
    Deploying needs `/collab` proxied to `COLLAB_PORT` — see README.
- **Current task**: none. Units 6 and 7 open as PRs off `dev`.
- **Mutation-verify every new test** (break impl, watch it fail, restore) AND
  click the unit in a real browser: `apiFetch` sent JSON with no body, 400'ing
  every bodyless DELETE/POST, and the stubbed-`fetch` suite never saw it (#110).
- **Deferred**: cloud backups, cli-visualizer (#9), symbol embeddings, partial
  restore, single-process arch. **Decided against 2026-08-22, do NOT re-open**:
  Leiden, a graph DB, GraphRAG summaries, cross-file calls.
- **Open issues**: #9; #101 (graph query-params, dead overload, dangling
  notifications on purge). #66 is closed by unit 6's CRDT. **Test-that-cannot-
  fail: SEVEN times**, always a fixture too uniform to tell working from broken.
