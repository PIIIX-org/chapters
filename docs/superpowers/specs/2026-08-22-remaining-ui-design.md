# Remaining UI — Design

**Status:** approved in brainstorming 2026-08-22. Covers every module that
needs a UI and does not have one.

## Why this exists

The backend is effectively complete — 88 HTTP endpoints across 18 route files.
The client calls 16 of them. A grep of `client/src` for `graph`, `repositor`,
`yjs`, or `collab` returns nothing, and `yjs` is not a client dependency.

Concretely, today: **a new user cannot create a vault from the UI** (`POST
/api/vaults` has no client caller), a deleted note is unrecoverable through
the app, and the three features the README leads with — the knowledge graph,
real-time collaboration, and codebase ingestion — are backend-only.

The product target is a **self-hosted multi-team knowledge base whose
differentiator is the graph**.

## Decisions

Each of these was a real fork; the rationale matters more than the choice.

1. **The graph is Home.** `2026-07-17-hosted-ui-structure-design.md` says the
   OSS edition's Home is a 2D node-graph and that there is "no
   dashboard-of-cards home page". The built vault-list page contradicts it.
   The spec wins. Vaults become a scope filter, not a destination. A user with
   no vaults gets an empty state carrying vault creation — the graph cannot be
   a landing page for someone who has nothing in it.

2. **The graph renders community clusters with drill-down.** `buildGraph()`
   returns ~285k edges at 10k notes (195k structural, 80k semantic, 10k
   extracted — measured, see `implementation.md`). No 2D force-directed
   renderer draws that interactively. Louvain communities are already computed
   (8 at 10k notes), so the view renders communities as super-nodes and
   expands one on demand. This is the only option that keeps a true overview at
   any corpus size, and it is why backend addition #1 exists.

3. **Code opens in a read-only viewer, with "open on GitHub" when git-sourced.**
   A viewer serves all three ingestion methods; a deep link serves none of
   `local_path` or `agent_push`. CodeMirror 6 is already wired, so the viewer is
   the existing editor with `readOnly: true` and a different language mode.

4. **Full yjs co-editing.** The Hocuspocus relay, per-message re-auth and
   revocation kick are already built and tested; only the client half is
   missing. CRDT merge closes issue #66 (lost-update race) by construction
   rather than mitigating it. Shipping sharing without it would knowingly open
   a data-loss path in a product whose pitch is shared vaults.

5. **⌘K ships in unit 1.** The spec says "no persistent left nav — global
   movement is ⌘K + the Sky". With the graph as Home and no left nav, ⌘K is the
   navigation layer, not a polish item.

6. **Vault deletion is soft-then-purge, owner-only.** Mirrors the note
   lifecycle. Creating freely with no way to remove is an asymmetry users
   notice immediately.

7. **Admin ships at position 3.** Signup returns `pending_approval` and the
   approval queue lives in Admin. Leaving Admin until last means nobody new can
   join the instance for the entire build.

8. **Fully responsive, including the graph** — pinch-zoom, tap-to-expand
   communities, controls in a bottom sheet on small screens. This is the most
   expensive answer and it lands on the hardest unit; see Risks.

9. **Progressive Home, so the bundle rule survives.** Decision 1 collides with
   performance rule 6 in `implementation.md` — "initial bundle < 300KB gzipped;
   heavy views (graph) lazy-load" — because a lazy-loaded Home is a blank first
   paint. Resolution: the shell, chrome, scope picker and empty state ship in
   the initial bundle under the existing 300KB budget; the graph renderer is a
   lazy chunk requested immediately after first paint, with a skeleton in
   place. The rule stands unamended and Home still paints instantly, at the
   cost of one visible loading beat on the graph canvas.

10. **Accessibility is gated in CI, per unit.** `vitest-axe` is added to the
    client suite; every new component ships an axe assertion and CI fails on
    violations. The design system asserts WCAG AA contrast but nothing has ever
    enforced it. Adding the gate before seven units of UI exist is far cheaper
    than retrofitting it across a graph canvas, a modal stack and a command
    palette afterwards. This is the one new dev dependency this design adds.

## Binding constraints (already approved — do not relitigate)

From `2026-07-19-ui-design-system.md`:

- Light-first **"paper & ink"**, editorial/refined. Dark mode is a genuine
  secondary night mode, never the brand's face. One intentional decoration: a
  faint paper-grain on the canvas.
- Type roles are fixed: **Petrona** display, **Hanken Grotesk** body/UI,
  **IBM Plex Mono** for code, paths, frontmatter and timestamps. Fraunces and
  Plus Jakarta Sans were rejected as overused AI defaults — do not reintroduce.
- **The dual-accent authorship rule is load-bearing**: vermillion `#BA3B1D` /
  `#E2683F` means a *person* authored it; teal `#2B6E6B` / `#4FA39F` means
  AI/MCP touched it. Colour means *who*, never decoration.
  - Practical consequence: Tailwind's `accent` role **is** the teal AI token,
    so generic shadcn `bg-accent` / `hover:bg-accent` on ordinary UI violates
    the rule. Use `bg-muted` for hover and active affordances.
- Collaborator cursors hash to exactly five "ink" hues — vermillion, indigo,
  plum, ochre, forest — and **teal is never assigned to a human**. Cursor
  tapers to a pen nib, not Figma's arrow.
- Surfaces: canvas `#F4F1EA`/`#17140F`, surface `#FAF7F0`/`#201C15`, recessed
  chrome `#EAE5D8`/`#0F0D0A`. Spacing base 8. Motion is intentional, not
  expressive.
- Every destructive or outward action confirms **inline, with its consequence
  in plain language** — never a bare "Are you sure?".
- `impeccable` fires on writes; findings get fixed or explicitly justified in
  the moment, never silently suppressed.

## Architecture

**Shell.** One authenticated shell: full-bleed graph canvas with chrome only at
the edges. Top-left scope picker (all / vault / repo), top-right notification
bell with drawer, bottom-left reserved for the hosted "Sky" button (absent in
OSS). No persistent left nav; the file tree exists only in Editor context.

**Routes.**

| Route | Purpose |
|---|---|
| `/` | Graph Home; empty state carries vault creation |
| `/vaults/:id/notes/*` | Editor (exists) |
| `/repos/:id/files/*` | Read-only code viewer |
| `/team` | Team page |
| `/admin` | Admin area |
| `/settings` | Account settings |

Vault settings is a **modal stack over any context**, per spec — not a route.

**Graph data flow.** The client requests the aggregated community graph;
expanding a community fetches its members. Ink-fade decay is computed
client-side from note timestamps. Colouring is by type/tag **or** by community,
toggled — layering both was considered and rejected. Physics controls (force
strength, link distance, clustering tightness, node size, edge styling) are
exposed, not hidden defaults.

**Cross-cutting client behaviour.** A `401` anywhere returns the user to login
without losing unsaved editor content; a `429` from the rate limiter surfaces
as a plain-language retry message rather than a generic failure. Both are
easily forgotten per-unit, so they belong in the shell.

**Secrets shown once** — MFA backup codes, sync tokens, webhook secrets — all
use one shared component.

## Backend additions

The backend is *not* complete for this UI. Five additions, all small, each
owned by the unit that needs it.

| # | Addition | Unit | Why |
|---|---|---|---|
| 1 | Community-aggregated graph endpoint | 1 | 285k edges cannot be sent or drawn |
| 2 | `GET` vault/repo graph-preference | 1 | Only `PUT` exists; the merged-view toggle cannot read its own state |
| 3 | Repository file **content** endpoint | 7 | Content is stored in `repositoryFiles.content`; nothing serves it. `GET /repositories/:id/files` is metadata only |
| 4 | `defaultBranch` on `repositories` | 7 | GitHub deep links need a ref; only `gitUrl` is stored |
| 5 | Vault soft-delete + purge | 1 | No vault delete endpoint exists at all |

## Units

Ordered so each step leaves the product usable and nothing waits on something
later.

### Unit 1 — Shell, graph Home, ⌘K, vault lifecycle
Backend: additions 1, 2, 5.
Client: app shell and chrome; graph canvas with community clustering,
drill-down, ink-fade decay, colouring toggle, exposed physics controls, filter
panel (type/tags/date); scope picker; vault create/rename/delete with inline
consequence copy; ⌘K with scope toggle, filters, and command entries (`open`,
`new vault`, `invite`) where actions are prefixed distinctly from results;
notification bell + drawer over `GET /notifications` and
`POST /notifications/:id/read`.
Also: ⌘K stops filtering out `code` results, and the dead `getVaultAccess`
client function is wired up or deleted.

### Unit 2 — Sharing and Team
Vault settings modal stack: sharing (grantee picker for user/team, read/edit,
revocation, inline "access is re-checked on every request" copy), `mergeable`
toggle with plain-language consequence, MCP connections scoped to the vault,
per-vault export. Team page: by-user constellation hero, roster of
**aggregate stats only** (the privacy rule is absolute — no per-note activity),
team create/manage, and the "who can reach this vault" expansion.

### Unit 3 — Admin and the onboarding path

**Onboarding is the reason Admin is here and not last.** Login requires
`status === 'active'` *and* `emailVerifiedAt` (`auth/routes.ts:169`); signup
sets neither. The first admin is fine — `/setup` creates an active, verified
admin from the one-time token the server prints on first boot, and logs them
in. Every subsequent user needs email verification *and* an admin approval, and
approval has no UI, so today a second person cannot get in without `curl` or
`psql`.

This unit closes that. It also fixes a UX hole: an unapproved user currently
gets a generic `401 invalid credentials` at login — correct, because saying
"pending approval" there would leak account existence — but it means they see
"wrong password" indefinitely with no idea what they are waiting for. The
resolution is to say it where there is no enumeration risk: the signup and
verify-email screens state plainly that an administrator must approve the
account before sign-in works, and the login screen stays generic. Do not
"improve" the login error.


One area, metadata-only throughout: approval queue over
`GET /admin/users?status=pending_approval` + `POST /admin/users/:id/approve`,
user management (`deactivate`/`promote`), vault and team oversight tables
(`GET /admin/vaults`, `/admin/teams`, `/admin/shares`), instance activity with
the security-event log and audit trail, aggregate stats (`GET /admin/stats`),
force-revoke of shares and MCP connections, and **instance backup download**
(`GET /admin/backup`). Restore stays a CLI (`pnpm restore-backup`) by
deliberate design — restoring over a live instance is not a button.

### Unit 4 — Settings and MFA
Account (email, password, **TOTP enrollment with backup codes shown once**),
notification preferences, account-wide MCP connections reusing the *same*
component as the vault-scoped list, and full-account export requests. TOTP
only — no SMS, no WebAuthn, no "remember this device", no admin-initiated
reset.

### Unit 5 — Trash, revision history, and import
Trash browser with restore, revision history panel in the Editor rail, revert,
and owner/admin-only revision purge. Endpoints all exist and are unused today,
which is why a deleted note is currently unrecoverable through the app.

Also **vault import** (`POST /api/import`, multipart zip) — the counterpart to
the export in unit 2. It is grouped here rather than with export because it is
a recovery path, and because an import that silently collides with existing
notes is the same class of hazard as an unrecoverable delete: the confirm step
must state what it will do to existing content.

### Unit 6 — Collaboration
`y-codemirror.next` against the existing Hocuspocus relay: live co-editing,
awareness-driven pen-nib cursors in the five ink hues, presence avatars in the
Editor top bar only (never a global "who's online" list), instant revocation
kick, and the SSE live view for read-only users. Autosave state whispers in the
breadcrumb, never a modal. Closes #66.

### Unit 7 — Repositories
Backend: additions 3, 4. Connect flow (git / local_path / agent_push), webhook
setup card surfacing the secret and `webhookPath` to paste into the git host,
sync health and last-synced state, sync-token management, read-only code
viewer with the per-file symbol outline, and "open on GitHub" for git-sourced
repos.

## Deployment prerequisites

Not code gaps — things that must be true of the environment, and are not today,
because the app has never been deployed.

- **SMTP must be configured in production.** `server/src/email/mailer.ts` falls
  back to *recording* mail when `SMTP_HOST` is unset. That is correct for dev
  and test, and silent data loss in production: signup verification and
  password reset would appear to work and never arrive. First item on the
  deploy checklist.
- **`CREDENTIALS_ENCRYPTION_KEY` must be set** (32-byte hex) or private-repo
  credentials and webhook secrets cannot be stored.
- **Exactly one instance.** Lockout state, the embedding queue, the extraction
  queue, MCP rate limiting and the repository poller are all in-process — see
  the single-process section of `implementation.md`. Horizontal scaling is not
  available, and a restart drops in-flight queue work. Accepted constraint, not
  a defect, but it bounds how this can be run.

## Testing

Each unit ships tests in the existing style: vitest + happy-dom for client,
real-database integration tests for the five backend additions. The community
aggregation endpoint is tested at 10k synthetic nodes, reusing the seeding in
`server/src/scripts/profile-graph.ts`.

## Assumptions

- **i18n is out of scope.** Nothing in either approved spec mentions it and no
  string extraction exists. Retrofitting later is real work; recorded here so
  the choice is visible rather than accidental.
- **The graph rendering approach is decided during planning**, biased toward the
  fewest new dependencies. Community clustering means the top-level view is
  tens of nodes, not thousands, so the expensive renderer is only needed once a
  community is expanded.

## Out of scope

Yildizim sky and the achievements economy (hosted-only, closed source).
Symbols as first-class graph nodes and editing code through Chapters — both
ruled out by `2026-07-18-code-graph-integration-design.md`. Cloud/scheduled
backups, symbol-level embeddings, partial restore. The four items decided
against on 2026-08-22: Leiden, a graph database, GraphRAG-style LLM community
summaries, cross-file call resolution.

## Risks

- **Responsive graph is the expensive intersection.** Full touch support lands
  on the single hardest unit. If unit 1 slips, degrading the phone experience
  to a scoped list is the release valve — decided against up front, but it is
  the cheapest thing to give back.
- **Nothing here has ever been run end-to-end by a real user.** The suite is
  green and a Docker image was built once, but there is no deployment and no
  manual QA pass. A real deploy plus a manual walkthrough should gate the first
  unit, not the last.
- **Unit 1 is large.** Shell, graph, ⌘K, vault lifecycle and notifications is a
  lot for one unit; it is grouped because the graph-as-Home decision makes them
  mutually blocking. Expect it to split into slices during planning.
- **One unreproduced test failure** was seen during PR #94 and never
  identified. It has not recurred in seven subsequent runs.
