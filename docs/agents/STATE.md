# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **UI phase DONE** (all 7 units + the redesign). PRs target `dev` directly,
  never stacked; `dev → prod` needs Taha's explicit OK. Detail in README +
  git log; only the traps live below.
  - **1** Louvain is **seeded** — drill-down addresses communities by number.
    ≈500ms at 10k notes, **not the bottleneck**; semantic edges **directed**.
  - **3** `/admin` is gated *before* any query fires, **metadata only**;
    **login stays generic on purpose** (account enumeration).
  - **4** **per-type notification prefs stay OUT of scope.**
  - **5** `actorType` is `user|mcp|collab`, no 'system'; **collab is a PERSON**,
    the commonest. `/history/*` metadata-only — **MCP `note_history` untouched**.
  - **6** **no autosave PUT** — the CRDT is the note. `/collab/ticket` returns
    a **path**: behind any proxy the server's `host` is the proxy's. The relay
    rides the app's own HTTP server on `/collab` — ONE port, no proxy anywhere.
    **revoked ≠ offline** — revoked KEEPS the doc (unsent text must survive).
  - **7** viewer read-only forever; local folders watched;
    **`gitUrl`/`localPath` are owner-only** (they leaked to viewers + MCP).
- **`prod` == `dev` as of 2026-08-31 (#142)** — the redesign, OIDC login
  (#132), the welcome mail (#126), the graph querystring fix (#129). `prod`
  runs 21 merge commits ahead with 0 non-merge commits of its own; check it
  that way, the raw ahead/behind count means nothing. Prod branch is `prod`,
  **not `main`** (`main` holds only the CLA commit and is dead).
- **Current task**: none. Pick from Open issues.
- **Phase: UI COMMAND REDESIGN** (owner-directed 2026-08-30): spec + plan of
  the same date under `superpowers/`. Dark-first grid shell (rail · top bar ·
  context · content · inspector) on every authed route; `/vaults`, `/repos`.
  **All 8 slices DONE** (2026-08-31). Slice 8 QA: headless Edge over 12 routes
  × 2 sizes × 2 themes, zero overlaps/scroll-x. Caught one real bug — the graph
  loaded cropped into the canvas corner (identity camera vs `forceCenter(0,0)`;
  first mount now centres world origin, a test pins it). `client/mock/` =
  fixture API for QA (`MOCK_PORT=3000` to sit behind vite).
- **Previous phase: DEPLOYABLE**. The API serves the client and the relay
  shares its port — one published port, verified in a browser with two tabs
  co-editing. The cold walkthrough as a stranger is done (2026-08-28).
- **Hosted = one container + one Postgres PER CUSTOMER**, and the app is **not
  forked** for it: one repo, one branch line; the control plane is a separate
  private repo the app must NEVER import or call. No edition flag — it would
  branch on nothing. See `implementation.md` "Product shape". Control plane =
  `PIIIX-org/chapters-cloud` (private, design approved 2026-08-28): OIDC
  provider + Docker provisioner, and **it claims `/api/setup` per customer —
  the setup token is the provisioning handshake, NOT a barrier to hosted
  signup**. #127 (in-app multi-tenancy) was closed for contradicting this;
  don't re-propose tenancy here. That debt **LANDED in #132** — generic OIDC
  login (`OIDC_ISSUER`/`_CLIENT_ID`/`_CLIENT_SECRET`/`OIDC_ONLY`), first
  sign-in LINKS to the setup-created admin by verified email.
  `chapters.piiix.org` is deployed but **unclaimed** — `/setup` never run.
- **#126**: approval mails the welcome; `notify()`'s `emailSubject`/`emailText`
  override the MAIL only, feed row stays short. **No SMTP = mail neither sent
  NOR logged** (in-memory array), so nobody can pass verification.
- **Mutation-verify every new test** AND click it in a real browser. Two whole
  features shipped green and broken: `apiFetch` sent JSON with no body (#110),
  and unit 6's ticket built its ws URL from fastify's `host`, the proxy's —
  537 tests passed while every editor 404'd the handshake.
- **Deferred**: cloud backups, cli-visualizer (#9), symbol embeddings, partial
  restore. Single-process is a PROPERTY, not a gap. **Decided against
  2026-08-22, do NOT re-open**: Leiden, a graph DB, GraphRAG, cross-file calls.
- **Open issues**: #123 (semantic-edges flake: HNSW recall, not a regression),
  #9. #66 (unit 6's CRDT) and #101 (#129) are closed. **Test-that-cannot-fail:
  SEVEN times**, always a fixture too uniform to tell working from broken.
