# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI, executing `specs/2026-08-22-remaining-ui-design.md` (10 locked
  decisions, 7 units). **PRs target `dev` directly, never stacked.** Promotion
  `dev → prod` needs Taha's explicit OK each time. Backend complete + twelve
  UI-driven additions; `pnpm profile-graph` ≈500ms at 10k notes, **Louvain NOT
  the bottleneck**; semantic edges stored **directed** (purges clear them, no FK).
- **Units 1–4 shipped** (detail in README + git log):
  - **1** graph Home (Canvas 2D + `d3-force`; SVG and cytoscape FAILED the
    probe), shell, vault lifecycle, ⌘K. **Louvain is seeded** — drill-down
    addresses communities by number, so ids must stay stable.
  - **2** vault settings **modal stack**, `/team`, `/users/lookup`
    (exact-match, non-enumerable), `/teams/:id/stats` (aggregates only).
  - **3** `/admin`, admins only, gated *before* any query fires: approvals,
    roster, vault+team oversight, access view (shares + MCP connections,
    force-revocable), paginated security log + audit trail, stats, backup.
    **Metadata only.** Signup/verify state the approval wait; **login stays
    generic on purpose** (enumeration).
  - **4** `/settings`: TOTP enrolment (backup codes once via `SecretReveal`),
    change email (clears verification — sign-in fails until re-verified, and
    the copy says so), change password (kills other sessions, spares yours),
    ONE notification-email switch, account-scope `McpPanel` (same component as
    the vault list, per spec), account export. Admin can mandate MFA
    instance-wide; `RequireAuth` then routes unenrolled users to `/settings`
    and the disable control is not rendered at all. Added to the API:
    `mfaEnabledAt`+`mfaRequired` on `/me`, `/me/{password,email,preferences,
    export}`, `users.emailNotifications`. **Per-type notification prefs stay
    OUT of scope** (the notifications spec defers them).
- **Current task**: none. Unit 4 open as a PR off `dev`. **Next**: 5
  trash/history/import · 6 collab (yjs) · 7 repositories.
- **Still no client UI**: everything units 5–7 cover. MCP needs none.
- **`apiFetch` declared JSON with no body** → every bodyless DELETE/POST 400'd
  in a browser; tests stub `fetch` (#110, fixed). Click a unit in a real
  browser before calling it done.
- **Test-that-cannot-fail: SEVEN times**, always a fixture too uniform to tell
  working from broken. Mutation-verify every new test.
- **Deferred**: cloud backups, cli-visualizer (#9), symbol embeddings, partial
  restore, single-process arch. **Decided against 2026-08-22, do not re-open**:
  Leiden, a graph DB, GraphRAG summaries, cross-file calls.
- **Open issues**: #9; #66 (updateNote race); #101 (graph query-params, dead
  overload, dangling notifications on purge).
