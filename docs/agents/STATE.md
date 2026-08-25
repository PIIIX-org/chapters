# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI, executing `specs/2026-08-22-remaining-ui-design.md` (10 locked
  decisions, 7 units). **PRs target `dev` directly, never stacked.** Promotion
  `dev → prod` needs Taha's explicit OK each time. Backend complete + twelve
  UI-driven additions; `pnpm profile-graph` ≈500ms at 10k notes, **Louvain NOT
  the bottleneck**; semantic edges stored **directed** (purges clear them, no FK).
- **Units 1–6 shipped** (detail in README + git log):
  - **1** graph Home (Canvas 2D + `d3-force`; SVG and cytoscape FAILED the
    probe), shell, vault lifecycle, ⌘K. **Louvain is seeded** — drill-down
    addresses communities by number, so ids must stay stable.
  - **2** vault settings modal stack, `/team`; `/users/lookup` is exact-match
    and non-enumerable, `/teams/:id/stats` aggregates only.
  - **3** `/admin` (approvals, roster, oversight, force-revoke, activity,
    stats, backup) — admins only, gated *before* any query fires, **metadata
    only**. **Login stays generic on purpose** (enumeration); the approval wait
    is stated on signup/verify instead.
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
  - **6** collaboration: one Yjs doc per note over the existing relay, **no
    autosave PUT** (the CRDT is the note — closes #66), pen-nib carets in five
    inks, presence in the Editor top bar only, SSE live view for readers.
    `POST /collab/ticket` returns a **path**, not a URL — the browser resolves
    it, because behind any proxy the server's `host` is the proxy's.
    **revoked ≠ offline**: revoked locks and keeps the doc (unsent text must
    survive); offline shows the last saved copy read-only and retries.
    Deploying needs `/collab` proxied to `COLLAB_PORT` — see README.
- **Current task**: none. Units 5, 6, 7 open as PRs off `dev`.
- **Mutation-verify every new test** (break impl, watch it fail, restore) AND
  click the unit in a real browser: `apiFetch` sent JSON with no body, 400'ing
  every bodyless DELETE/POST, and the stubbed-`fetch` suite never saw it (#110).
- **Deferred**: cloud backups, cli-visualizer (#9), symbol embeddings, partial
  restore, single-process arch. **Decided against 2026-08-22, do NOT re-open**:
  Leiden, a graph DB, GraphRAG summaries, cross-file calls.
- **Open issues**: #9; #66 (updateNote race); #101 (graph query-params, dead
  overload, dangling notifications on purge). **Test-that-cannot-fail: SEVEN
  times**, always a fixture too uniform to tell working from broken.
