# Chapters — MCP Integration

Sub-project 6 of 6. Structural design only — no implementation detail.

## Depends on

- Sub-project 1 (Auth & Vault/Sharing model): every `MCPConnection` (account
  or vault scoped, defined in that spec) is the authentication/authorization
  unit for everything in this spec. Access is always resolved live against
  the connection owner's current permissions — never cached or assumed from
  connection-creation time.
- Sub-project 2 (Editor): note read/write operations exposed here map
  directly onto that spec's note lifecycle (create, edit) and OKF-compliant
  structure (type-first creation, frontmatter validity).
- Sub-project 3 (Graph engine & view): graph-query operations exposed here
  read from that engine's edges (EXTRACTED/INFERRED) and communities.
- Sub-project 4 (Search): search operations exposed here call the exact
  same hybrid keyword+semantic search function the human UI uses — this was
  already assumed as a requirement in that spec.
- Sub-project 5 (Real-time collaborative editing): AI writes issued through
  MCP go through this same CRDT sync engine, not a separate write path.

## Goals

- Give every account permission-aware, first-class AI access — not a
  bolt-on read-only integration, but the same operations a human has
  through the UI, scoped identically.
- Make AI edits transparent: visible while happening, attributable
  afterward, and reversible if wrong.
- Guarantee strict isolation between MCP connections and, absolutely,
  between accounts — this matters more here than anywhere else in the
  product, since multiple AI agents (possibly from different users, and
  possibly multiple agents on the same account) may be operating against
  shared vaults concurrently and unsupervised.

## Operations exposed

Full parity with what a human user can do through the UI, all scoped by
the calling connection's live effective permission:

- **Read**: fetch a note's frontmatter/body by path, browse a vault's tree.
- **Write/edit**: create or edit notes, gated by `edit`/`owner` permission
  on the target vault — same as a human editor.
- **Delete**: always a soft delete (see below).
- **Search**: the same hybrid keyword+semantic search from sub-project 4 —
  one search function, no AI-specific query mode, consistent with that
  spec's "one search function, two callers" design (now three callers:
  human UI, and however many concurrent MCP connections).
- **Graph queries**: structural questions the graph engine already answers
  (what links to this note, what community/cluster it belongs to, filtered
  views) — exposed directly rather than making the AI re-derive graph
  structure from raw note text.

## Write path

- **AI writes and edits flow through the same CRDT collaboration engine as
  human edits** (sub-project 5), not a separate direct-save path. Each
  active MCP connection appears as its own visible participant — its own
  presence color and a label identifying it as AI (e.g. by connection
  name) — exactly like a human collaborator's cursor.
- This means: if a human has a note open while an MCP connection edits it,
  they see the AI's changes streaming in live, the same way they'd see a
  teammate's edits. There is no code path where an AI edit appears as a
  sudden, unexplained change to a note someone is actively viewing.

## Deletion

- **All deletion is a soft delete** — notes move to a recoverable trash
  (restorable within some window), regardless of whether the actor is a
  human through the UI or an AI through MCP. One consistent delete
  behavior, not a special-cased AI-safety rule bolted onto an otherwise
  permanent-delete system.

## Audit trail

- A minimal per-note change log: each change records a timestamp and its
  actor — either a specific human user or a specific `MCPConnection` — plus
  enough information to **revert** the note to a prior recorded state.
- This is new scope relative to sub-project 5, which explicitly deferred
  version history. Autonomous AI writes are why it can no longer stay
  deferred: a bad AI edit or delete needs a recovery path even if nobody
  was watching the live collaboration session when it happened.
- The audit log and the live collaboration presence (sub-project 5) serve
  different purposes and both stay: presence is real-time transparency
  while something is happening; the audit trail is after-the-fact
  accountability and recovery.

## Isolation & safety

- **Every MCP connection's access is recomputed live on every call**,
  against that connection's own current resolved permissions — this was
  already the rule from sub-project 1, restated here as a hard constraint
  because it's the property this entire sub-project depends on for safety.
- **No caching layer may span connections or accounts.** Any performance
  caching (search results, embedding lookups, graph query results, etc.)
  must be keyed strictly to the requesting connection's live permission
  scope. A cache entry computed for one connection is never reused to
  answer a different connection's request, even if both happen to resolve
  to the same vault — the permission check must always run per-request,
  not be shortcut by a shared cache hit.
- **Cross-account isolation is absolute, with no exceptions.** No code
  path, admin role, or caching layer may allow one account's MCP
  connection to observe or affect another account's data. This holds
  regardless of circumstance — there is no "trusted" or "internal" bypass
  of the permission model for MCP traffic.
- **Concurrent agents don't corrupt each other's work.** Whether multiple
  MCP connections belong to the same account or to entirely different
  accounts, simultaneous access to a shared vault is handled the same way
  sub-project 5 already handles simultaneous human editors: each
  connection is an independent participant in the CRDT sync, which
  guarantees conflict-free merging by construction — no additional
  agent-specific locking or coordination logic is needed.

## Explicitly out of scope for this sub-project

- **The MCP connection creation/management UI** (generating a token,
  naming a connection, revoking it) — that UI and the `MCPConnection` data
  model itself belong to sub-project 1; this spec only defines what an
  already-issued connection is allowed to *do*.
- **Rate limiting / abuse prevention specifics** (e.g. request quotas per
  connection) — a real operational concern, but a tuning/implementation
  decision rather than a structural one, deferred to implementation time.
- **Trash retention window length and permanent-purge policy** — the
  soft-delete mechanism is specified here; how long deleted notes remain
  recoverable before permanent purge is an implementation-time decision.

## Assumptions carried forward (revisit if wrong)

- An MCP connection's "AI" presence label in the collaboration engine is
  derived from the connection's name/metadata (set at creation, per
  sub-project 1), not a separate identity system.
- The audit trail's revert capability restores a note to a prior recorded
  state; it does not need to support arbitrary point-in-time branching or
  merge-conflict resolution between two reverts — simple linear history is
  assumed sufficient for v1.
