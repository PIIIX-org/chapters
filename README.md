# Chapters

An open-source, self-hostable "second brain" platform: a team knowledge base
built on plain markdown files, a live-preview editor, and an AI-navigable
knowledge graph.

**Status: backend complete; UI phase underway (Slice 1 — Scaffold + Auth,
Slice 2a — vault tree + read-only note view, Slice 2b-1 — CodeMirror 6
basic editing + debounced autosave, Slice 2b-2 — permission-aware editor
lock, and Slice 2b-3 — editable frontmatter property panel — done; the
rest of Slice 2b — note lifecycle, live-preview rendering — next).** All specs
([`docs/superpowers/specs/`](docs/superpowers/specs/)) are implemented
server-side on the decided stack (TypeScript end to end: Node/Fastify +
Yjs/Hocuspocus + PostgreSQL/pgvector + local ONNX embeddings — chosen
for best AI navigability, see
[`2026-07-17-tech-stack-decision.md`](docs/superpowers/specs/2026-07-17-tech-stack-decision.md)):

- **Auth & sharing** — setup-token bootstrap, signup→verify→approve,
  sessions, teams, vault shares with live permission resolution, MFA
  (TOTP + backup codes, admin-mandatable)
- **Notes** — plain OKF markdown files on disk, one shared server-side
  validation for every write path, soft-delete trash, per-type index.md
- **Graph & search** — save-time embedding index; extracted/structural/
  semantic edges with Louvain communities and an opt-in merged
  cross-vault view; hybrid keyword+semantic search, permission-filtered
  in-query
- **Real-time collaboration** — Yjs relay with per-operation live
  permission checks, instant revocation kick, and an identity-free live
  view for read-only users
- **MCP** — permission-scoped AI access with full tool parity, writes
  flowing through the live collaboration engine, attributed audit trail
  with revert and hard purge, per-connection rate limits
- **Export & portability** — zip exports with manifest, expiring share
  links, validated import, full-instance admin backup and a matching
  `pnpm restore-backup` CLI (deliberately not an HTTP endpoint) for
  disaster recovery onto a fresh instance
- **Admin oversight** — metadata-only dashboards and instance-wide
  force-revoke; never note content

**Codebase mapping** is also implemented, extending the platform beyond
notes to also index and query code — read-only, sharing the same graph/
search/MCP engines rather than a parallel one:

- **Repository ingestion & permissions** — connect a codebase via git
  URL (shallow clone + webhook/poll freshness), a local path (real-time
  filesystem watch), or an agent/CLI push, and share it read-only the
  same way a vault is shared. See
  [`2026-07-18-repository-ingestion-design.md`](docs/superpowers/specs/2026-07-18-repository-ingestion-design.md).
- **Code graph & unified search/MCP** — tree-sitter-derived import and
  symbol structure; `buildGraph`/`searchNotes` extended to span both
  vaults and repositories (one function, every caller); semantic edges
  between a note and the code it describes, since both share one
  embedding space; a `repo:` wikilink form links notes directly to
  code; MCP gains repository-aware tools and a hard-scoped connection
  type. See
  [`2026-07-18-code-graph-integration-design.md`](docs/superpowers/specs/2026-07-18-code-graph-integration-design.md).

The UI (React + CodeMirror 6) is underway — Slice 1 (Scaffold + Auth),
Slice 2a (vault tree + read-only note view), Slice 2b-1 (CodeMirror 6
basic editing + debounced autosave), Slice 2b-2 (permission-aware editor
lock), and Slice 2b-3 (editable frontmatter property panel) are done; the
remaining Slice 2b increments (note lifecycle, live-preview rendering) are
next — tracked in [`docs/agents/STATE.md`](docs/agents/STATE.md).

**Running it**: `Dockerfile` (repo root) + `server/.env.example` cover a
real deployment — security headers on by default, CORS off (same-origin
only) unless `CORS_ORIGIN` is set, Dependabot watching dependencies. One
real constraint worth knowing before scaling: this backend assumes a
single running instance (lockout counters, the embedding/extraction
queues, the live-collaboration permission-kick bus, MCP rate limiting,
and repository polling are all in-process state) — see
[`docs/agents/implementation.md`](docs/agents/implementation.md)'s
"Deployment topology" section before running more than one instance.

The frontend (`client/`) is a Vite + React app. In development, run the
API (`pnpm -C server dev`) and the frontend (`pnpm -C client dev`)
side by side — Vite proxies `/api/*` to the API on port 3000, so no CORS
configuration is needed locally. `pnpm -C client build` produces a static
`client/dist/` bundle to serve behind the same reverse proxy as the API in
production.
Logged-in users can browse their vaults and edit notes with a real
CodeMirror 6 editor (`/vaults/:id/notes/*`, debounced autosave) plus a
structured property panel for the note's frontmatter (`type` shown
read-only, `resource`/`tags`/`timestamp` editable, extra keys preserved);
read-only collaborators get the same note rendered but locked. Note
create/rename/delete and live-preview rendering arrive in later UI
sub-plans.

Development runs on a two-branch model — everything lands on **`dev`**
(default) via reviewed PRs and is promoted to **`prod`** once verified —
and is agent-driven: the working agreements (implementation prompt, file/
context/resume/testing protocols, GitHub workflow) live in
[`docs/agents/`](docs/agents/). For a full technical walkthrough of the
backend — every subsystem, the data model, security posture, testing/
deployment, and a maintenance runbook — see
[`docs/agents/backend-reference.md`](docs/agents/backend-reference.md).

All six sub-project specs have been through a dedicated security audit; see
[`2026-07-12-security-audit-findings.md`](docs/superpowers/specs/2026-07-12-security-audit-findings.md)
for the findings and each affected spec's "Security hardening" section for
the resulting design changes.

## Why we're building this

Every note-taking tool we looked at forced a trade-off we didn't want to
make:

- **Obsidian** is excellent for a single person's notes, but it's a local
  desktop/mobile app with no server mode — there's no way to run it as a
  shared, always-available team knowledge base, and it's closed source, so
  we can't fix that ourselves.
- **Closed SaaS tools** (Recall.ai and similar) solve "access from
  anywhere," but your notes live in someone else's proprietary format and
  graph — you can't point your own tools (or an AI assistant) at the raw
  data.
- **Enterprise data catalogs** (like Google Cloud's Knowledge Catalog) solve
  structured, AI-navigable knowledge at scale, but they're built for
  corporate data governance, not for a team quickly writing and linking
  notes together.

We wanted the parts of each that actually matter — Obsidian's fast,
local-first editing feel; a real server so the whole team can reach the
same knowledge base from anywhere; and a knowledge graph structured well
enough that an AI assistant can navigate it accurately without burning
tokens re-deriving structure that should already be explicit.

## Design principles

- **Notes are plain files, always.** Every note is markdown + YAML
  frontmatter, following Google's [Open Knowledge Format
  (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
  spec — a vendor-neutral, version-controllable way to represent knowledge
  as `type/name` files with typed frontmatter and linked relationships. No
  proprietary database holding your notes hostage.
- **The graph is a first-class citizen, not an afterthought.** Relationship
  modeling is inspired by [Graphify](https://github.com/Graphify-Labs/graphify):
  explicit (`EXTRACTED`) edges from real links, and derived (`INFERRED`)
  edges from shared structure or semantic similarity, with automatic
  community detection on top.
- **AI access is a permission-aware, first-class feature**, not a bolt-on.
  Every account can connect an AI assistant via MCP — scoped to exactly the
  vaults that account can already see, respecting the same read/edit rules
  as the UI.
- **Self-hosted and open source.** One deployment serves one organization.
  The code is open so anyone can run their own instance.

## Project structure

This is being built as a sequence of dependency-ordered sub-projects, each
with its own design spec before any code is written:

1. **Auth & Vault/Sharing model** — accounts, teams, vaults, granular
   sharing permissions. Everything else depends on this.
2. **Editor** — live-preview markdown editing (CodeMirror 6), OKF-compliant
   by construction.
3. **Graph engine & view** — the OKF/Graphify-inspired knowledge graph,
   customizable clustering, filtering, and merged cross-vault views.
4. **Full-text search** — tuned for accurate, fast AI recall.
5. **Real-time collaborative editing** — live multi-user editing.
6. **MCP integration** — scoped AI-assistant access per account and per
   vault.
7. **Data export & portability** — per-note/per-vault download, shareable
   export links, cross-instance import, and full-instance admin backup.
8. **Repository ingestion & permissions** — connecting a codebase
   (git URL, local path, or agent/CLI push), kept fresh, shared read-only
   the same way a vault is. See
   [`2026-07-18-repository-ingestion-design.md`](docs/superpowers/specs/2026-07-18-repository-ingestion-design.md).
9. **Code graph & unified search/MCP integration** — tree-sitter-derived
   code structure joining the existing graph/search/MCP engines, so notes
   and code are one navigable, queryable knowledge base. See
   [`2026-07-18-code-graph-integration-design.md`](docs/superpowers/specs/2026-07-18-code-graph-integration-design.md).

See [`docs/superpowers/specs/`](docs/superpowers/specs/) for the detailed
design of each completed sub-project.

Beyond the core 7, additional cross-cutting specs closing tracked gaps:

- **Notifications & activity feed** — five triggers (vault shared/revoked,
  team membership changes, note reverted, signup approved, team-share
  changes), delivered in-app + email. See
  [`2026-07-15-notifications-activity-feed-design.md`](docs/superpowers/specs/2026-07-15-notifications-activity-feed-design.md).
- **Admin oversight dashboard** — metadata-only instance visibility
  (users, vaults, teams, storage, activity), unifies existing admin
  actions in one place, plus a force-revoke incident-response lever that
  never grants content access. See
  [`2026-07-15-admin-oversight-dashboard-design.md`](docs/superpowers/specs/2026-07-15-admin-oversight-dashboard-design.md).
- **Multi-factor authentication** — TOTP, opt-in per user or
  admin-mandated instance-wide, with one-time backup codes for recovery.
  See [`2026-07-15-mfa-design.md`](docs/superpowers/specs/2026-07-15-mfa-design.md).
- **Hosted UI structure** — page-by-page IA, user flows, and component
  placement for the hosted app, where the Yildizim galaxy layer is Home
  and 2D pages frame the work. See
  [`2026-07-17-hosted-ui-structure-design.md`](docs/superpowers/specs/2026-07-17-hosted-ui-structure-design.md).

## User flow & system diagrams

Visual diagrams covering the flows that cross the six sub-project specs.
Each image links to a self-contained, interactive HTML/SVG version under
[`docs/superpowers/specs/diagrams/`](docs/superpowers/specs/diagrams/) —
open it directly in a browser for the full-resolution vector version.

### Onboarding
Signup through first note.

[![Onboarding flow](docs/superpowers/specs/diagrams/01-onboarding-flow.png)](docs/superpowers/specs/diagrams/01-onboarding-flow.html)

### Sharing & permissions
Grant, live re-check, revoke.

[![Sharing & permissions flow](docs/superpowers/specs/diagrams/02-sharing-permissions-flow.png)](docs/superpowers/specs/diagrams/02-sharing-permissions-flow.html)

### AI/MCP connection
Scoped tokens, live permission check.

[![AI/MCP connection flow](docs/superpowers/specs/diagrams/03-mcp-connection-flow.png)](docs/superpowers/specs/diagrams/03-mcp-connection-flow.html)

### Live collaboration
CRDT presence, mid-session revocation.

[![Live collaboration flow](docs/superpowers/specs/diagrams/04-live-collaboration-flow.png)](docs/superpowers/specs/diagrams/04-live-collaboration-flow.html)

### Graph exploration
Clustering, filters, merged view.

[![Graph exploration flow](docs/superpowers/specs/diagrams/05-graph-exploration-flow.png)](docs/superpowers/specs/diagrams/05-graph-exploration-flow.html)

### Search
Hybrid retrieval, permission-filtered results.

[![Search flow](docs/superpowers/specs/diagrams/06-search-flow.png)](docs/superpowers/specs/diagrams/06-search-flow.html)

### System data flow
Full component/connection architecture map.

[![System data flow architecture](docs/superpowers/specs/diagrams/07-system-data-flow.png)](docs/superpowers/specs/diagrams/07-system-data-flow.html)

### AI navigation
How an agent uses search + graph via MCP.

[![AI navigation flow](docs/superpowers/specs/diagrams/08-ai-navigation-flow.png)](docs/superpowers/specs/diagrams/08-ai-navigation-flow.html)

## Known gaps / future work

Every gap surfaced by the security audit now has a spec (see above). Items
below are tracked but not yet designed:

- **Cloud storage integrations** (Google Drive, Dropbox, S3, etc.) and
  **automated/scheduled backups** — deliberately deferred out of
  sub-project 7's core scope (see that spec); each needs its own
  design pass once the manual export/import primitives exist.
- **CLI execution visualizer** — an opt-in mode for following what a CLI
  command does internally, proposed in
  [issue #9](https://github.com/PIIIX-org/chapters/issues/9). Deferred
  until the backend and its CLI surface exist; see
  [`2026-07-17-cli-visualizer-design.md`](docs/superpowers/specs/2026-07-17-cli-visualizer-design.md).
- **MCP `rename_note` tool** — a viral X post/article claiming "MCP is the
  missing piece between Claude Code and your Obsidian vault" prompted a
  look at community vault-as-MCP-server projects (e.g.
  [obsidian-claude-code-mcp](https://github.com/iansinnott/obsidian-claude-code-mcp),
  the ["Vault as MCP" Obsidian plugin](https://community.obsidian.md/plugins/vault-as-mcp)).
  Their tool surface (read/search/create/update/delete/rename notes, daily
  notes, templates) is narrower than Chapters' own 14-tool MCP layer
  (permission-scoped tokens, CRDT-safe collaborative writes, RRF-fused
  search over notes *and* code, revision history/revert — see
  `docs/agents/backend-reference.md` §5.8) — so the pattern itself isn't
  something Chapters needs to adopt. One concrete gap did turn up: `rename`
  has a REST route and a `renameNote()` store function already (used by the
  UI's upcoming note-lifecycle work in Slice 2b) but no MCP tool wraps it
  yet, unlike `search`/`graph`, which share their REST implementation.
  Low-effort addition once Slice 2b's note lifecycle lands. Daily/periodic
  notes and template tools were considered and not adopted — they assume a
  journaling workflow that doesn't fit Chapters' OKF-typed note model.

## Contributing

The backend and Slice 1 of the UI (scaffold + auth) are implemented; the
Editor and later slices haven't started. Design feedback on open specs
(see "Known gaps" above) is useful at any time; code contributions should
target gaps in the implemented backend/UI or wait for the next slice —
check `docs/agents/STATE.md` for current status.
