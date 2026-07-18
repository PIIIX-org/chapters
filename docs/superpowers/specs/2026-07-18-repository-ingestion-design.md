# Chapters — Repository Ingestion & Permissions

Sub-project 8. Structural design only — no implementation detail.
Foundational layer for codebase mapping (README known-gap); sub-project 9
builds the graph/search/MCP integration on top of what this spec defines.

## Product context

Chapters is scoped around notes (OKF markdown) only. This extends it to
also map **codebases** — read-only — so both a human (graph view) and an
AI (MCP) can navigate code with the same structural understanding they
already get for notes. Researched against
[Graphify](https://graphify.net/), the tool the existing graph engine
already borrows its EXTRACTED/INFERRED vocabulary from: Graphify runs
locally as a coding-agent skill (no ingestion problem — the code is
already on the machine it runs on) and gets a measured ~70x token
reduction querying a structural graph vs. reading raw files. Chapters
can't fully replicate "zero ingestion" because it's a hosted,
multi-user server, not a local CLI — this spec is the ingestion layer
Graphify never needed.

## Depends on

- Sub-project 1 (Auth & Vault/Sharing model): `Repository` mirrors
  `Vault`'s owner/share/team access pattern, using the same live
  resolution principle (never cached, always re-checked per request).

## Goals

- Let a user connect a codebase to Chapters via any of three methods,
  and share it (read-only) the same way a vault is shared.
- Keep the codebase's local copy/index fresh, with a concrete freshness
  mechanism per ingestion method — not a vague "real-time" promise.
- Converge all three ingestion methods on one shape (changed files, with
  content and hashes) so the extraction pipeline (sub-project 9) has
  exactly one code path to trust, regardless of source.

## Read-only, by design

Chapters never writes to source code. No editor, no CRDT collaboration,
no OKF-style validation, no soft-delete trash, no audit/revert — those
all exist for notes because notes are authored *in* Chapters. Code isn't;
git (or whatever the source repo uses) remains the record of truth and
history. A repository's indexed content is hard-deleted and replaced on
every sync — it's a derived index, not authored content.

## Entities

- **Repository** — owned by one User. `name`, `ingestionMethod`
  (`git` | `local_path` | `agent_push`), `sourceConfig` (method-specific:
  git remote URL + encrypted credential reference; or an allowlisted
  local path; empty for `agent_push`), `mergeable` flag (same semantics
  as `Vault.mergeable` — gates inclusion in a merged cross-vault/
  cross-repository graph, default off), `lastSyncedAt`, `syncStatus`
  (`idle` | `syncing` | `error`).
- **RepositoryShare** — (repository, grantee). Grantee is a User or a
  Team, same polymorphism as `VaultShare`. Only **owner** grants/revokes
  — same anti-escalation rule as vaults. No permission-level field:
  since content is never editable, a grant is binary (viewer) rather
  than read/edit — the only thing "more" than viewing is owner-only
  config/share/delete/manual-reindex actions.
- **RepositoryGraphPreference** — per (User, Repository): "include this
  repository in my merged graph." Effective only if `mergeable` is on —
  identical mechanics to `VaultGraphPreference`.
- **RepositoryFile** — the indexed content: `path` (full relative path,
  arbitrary depth — not the OKF `type/name` slug convention notes use),
  `language` (detected from extension, nullable if unrecognized),
  `content`, `contentHash` (sha256 — the same signal Graphify uses to
  skip reprocessing unchanged files), `size`, `sourceModifiedAt`.
- **RepositorySyncToken** — per Repository, used by the `agent_push`
  ingestion method: generated, shown once, stored hashed, revocable —
  same lifecycle as an MCP connection token, but a distinct mechanism
  (this pushes raw sync data; MCP tokens make tool calls — different
  capability, not reused).

## Access resolution rule

Same shape as the vault rule, simplified to two tiers since nothing is
editable: a user can reach a repository if they own it, or there is a
direct or team `RepositoryShare` to them. Effective access is `owner` or
`viewer`. Requires `active` user status, resolved live on every request
— never cached, never assumed from a prior check, identical posture to
`resolveAccess` for vaults.

## Why a separate entity, not a new note type or a vault attachment

Two structural reasons this isn't squeezed into the existing vault/note
model:
- **Code doesn't fit the OKF shape.** Notes require `type/name` slug
  paths, YAML frontmatter, and are individually editable; a repository's
  file tree has arbitrary nesting and filenames, and is never edited.
  Stretching the notes table to cover this would compromise the
  guarantee that every note row is a valid OKF file.
- **Independent sharing has real value.** A company-wide repository
  might be linked from several project vaults' notes; tying a repository
  to exactly one vault's permission list would force either duplication
  or awkward reuse. An independent entity, referenceable from any vault
  a user can reach, mirrors how the merged-graph feature already treats
  vaults as independently-shareable units that can combine.

**Rejected alternative**: generalizing `VaultShare`/`Vault` into a
polymorphic "shareable resource" abstraction spanning both types. The
vault permission system is fully built, tested, and in production;
touching it to accommodate a second resource type is unnecessary risk
for a speculative abstraction. Duplicating the same shape into
`Repository`/`RepositoryShare`/`RepositoryGraphPreference` costs a small
amount of repetition and touches nothing already shipped — consistent
with this project's standing preference for concrete duplication over
premature generalization (`vaultShares.granteeType` itself only
generalizes over user/team, not further). Revisit if a third resource
type ever needs the same pattern.

## Ingestion methods

All three converge on the same input to the sync pipeline: a batch of
changed files (path, content, contentHash) plus a full path manifest so
deletions can be detected by diffing against what's currently indexed.
*How* that batch arrives is the only difference:

### Git URL

- Shallow clone (`depth 1` — current tree only, no history) into the
  instance's local working-copy area for that repository. A full clone
  is never needed: nothing in this design reads git history/blame.
- **Freshness**: a webhook registered on the git host (GitHub/GitLab
  push event) triggers a `git fetch` + diff against the previous known
  state, re-syncing only files whose content hash actually changed —
  genuinely real-time (webhook delivery latency, not polling).
- **Fallback**: self-hosted instances are frequently not reachable from
  the public internet (LAN, no domain, behind NAT), so webhook delivery
  isn't guaranteed. A polling loop on a configurable interval (default:
  a few minutes) is the fallback — used automatically whenever no
  webhook delivery has been observed recently, not as a manual toggle.
- **Credentials**: an optional deploy key or access token for private
  repositories. Unlike passwords or MCP tokens, this must be **usable
  again** for future pulls, so it cannot be one-way hashed — it's
  encrypted at rest with a server-side key from config/secrets, never
  returned by any read endpoint after it's set.

### Local path

- Admin-configured path, restricted to an allowlisted root directory
  (`LOCAL_REPOS_ROOT`-style scoping) — the same path-traversal posture
  the OKF slug validation already gives notes, applied here at the
  config boundary instead of per-path-segment validation.
- **Freshness**: a filesystem watcher (chokidar) on the path gives true
  real-time, sub-second change detection, debounced to avoid re-syncing
  mid-write.

### Agent/CLI push

- No clone, no watcher — a `RepositorySyncToken`-authenticated push
  endpoint accepts a batch of changed files directly from a client that
  already has the repository checked out locally (e.g. a coding agent's
  own session). This is the closest analog to how Graphify itself
  operates: the code never needs to be fetched by the server at all,
  because whoever already has it locally sends the update.
- **Freshness**: entirely event-driven from the pushing client's side —
  Chapters is a passive receiver, not the one watching for changes.

**Rejected for v1**: accepting a pre-computed graph fragment (nodes/
edges already extracted client-side) from the `agent_push` method
instead of raw file content. Rejected for two reasons: it would require
trusting and validating an externally-computed graph rather than one
process being the single source of truth, and it would mean maintaining
two independent implementations of the extraction logic (client and
server) that could silently drift. All three methods deliver raw file
content; sub-project 9's extraction pipeline is the only thing that ever
parses it, regardless of source.

## Explicitly out of scope for this sub-project

- **The extraction/parsing pipeline itself** (tree-sitter, import/symbol
  edges) — sub-project 9; this spec only defines how file content
  arrives and is stored, not what's derived from it.
- **Multi-modal ingestion** (PDFs, images, non-code docs) — Chapters
  already has notes as its documentation layer; this isn't a gap the
  platform has.
- **Manual/selective sync** (choosing specific paths/branches to
  include) — v1 syncs the whole default branch; narrower scoping is a
  future refinement if a real need surfaces.
- **Any write path back to the source** — read-only per the goals above,
  not a deferred feature but a hard boundary.

## Assumptions carried forward (revisit if wrong)

- Default branch only, for git-sourced repositories — no branch
  selection in v1.
- Polling interval and webhook-staleness threshold are implementation-
  time tuning decisions, not fixed here.
- File size cap for indexed content (to bound embedding/storage cost per
  file) is an implementation-time decision, consistent with how note
  content has no explicit cap today.
