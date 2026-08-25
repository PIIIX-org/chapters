# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI, executing `specs/2026-08-22-remaining-ui-design.md` (10 locked
  decisions, 7 units). **PRs target `dev` directly, never stacked.** Promotion
  `dev → prod` needs Taha's explicit OK each time. Backend complete + twelve
  UI-driven additions; `pnpm profile-graph` ≈500ms at 10k notes, **Louvain NOT
  the bottleneck**; semantic edges stored **directed** (purges clear them, no FK).
- **Units 1–5 shipped** (detail in README + git log):
  - **1** graph Home (Canvas 2D + `d3-force`), shell, vault lifecycle, ⌘K.
    **Louvain is seeded** — drill-down addresses communities by number.
  - **2** vault settings modal stack, `/team`; `/users/lookup` exact-match and
    non-enumerable, `/teams/:id/stats` aggregates only.
  - **3** `/admin` — admins only, gated *before* any query fires, **metadata
    only**. **Login stays generic on purpose** (enumeration).
  - **4** `/settings`: TOTP (codes once), change email/password, ONE
    notification-email switch, account `McpPanel`, account export. Admin can
    mandate MFA; `RequireAuth` then forces enrolment and disable is not
    rendered. **Per-type notification prefs stay OUT of scope.**
  - **5** note trash + restore (vault settings modal), vault purge (closes the
    promise its own delete copy made), Editor history rail (revert = a NEW
    attributed revision, nothing erased; owner-only revision purge), and import
    (ALWAYS makes a new vault; reports skip reasons + unmatched shares).
    Paginated `/history/*` (metadata only — **MCP `note_history` deliberately
    untouched**) and `/trash`. `actorType` is `user|mcp|collab`, no 'system';
    **collab is a PERSON** (vermillion), it is the default actor for relay saves.
- **Current task**: none. Unit 5 open as a PR off `dev`. **Next**: 6 collab
  (yjs) · 7 repositories — both building in worktrees `-u6` / `-u7`.
- **Mutation-verify every new test** (break impl, watch it fail, restore) AND
  click the unit in a real browser: `apiFetch` sent JSON with no body, 400'ing
  every bodyless DELETE/POST, and the stubbed-`fetch` suite never saw it (#110).
- **Deferred**: cloud backups, cli-visualizer (#9), symbol embeddings, partial
  restore, single-process arch. **Decided against 2026-08-22, do NOT re-open**:
  Leiden, a graph DB, GraphRAG summaries, cross-file calls.
- **Open issues**: #9; #66 (updateNote race); #101 (graph query-params, dead
  overload, dangling notifications on purge). **Test-that-cannot-fail: SEVEN
  times**, always a fixture too uniform to tell working from broken.
