# Chapters — Real-Time Collaborative Editing

Sub-project 5 of 6. Structural design only — no implementation detail.

## Depends on

- Sub-project 1 (Auth & Vault/Sharing model): who may participate as an
  active editor vs. a live viewer follows the same `read`/`edit`/`owner`
  effective permission on the vault.
- Sub-project 2 (Editor): this sub-project replaces that spec's single-user
  save/load mechanism with true concurrent multi-user sync. Everything
  else from the Editor spec — layout, wikilinks, note lifecycle,
  type-first creation — is unchanged; only the persistence/sync layer
  changes.

## Goals

- Let multiple users edit the same note at the same time, with changes
  merging live (Google Docs-style), not last-write-wins.
- Make simultaneous editing legible: show who else is present and where
  they're working, not just text changing with no visible cause.
- Extend live sync to read-only viewers as well, so "read access" means
  seeing current state, not a stale snapshot.
- Handle disconnect/reconnect gracefully without requiring full
  offline-first architecture in v1.

## Sync model

- **CRDT-based** (e.g. Yjs or equivalent) synchronization replaces the
  autosave/last-write-wins persistence described in sub-project 2. Instead
  of periodic snapshots, all edits merge continuously through the CRDT's
  conflict-free merge semantics.
- **Scope covers the whole note**: both the markdown body and the
  structured frontmatter property panel are live-synced. The Editor spec
  keeps these as two visually distinct areas, but both go through the same
  sync engine — there is no split where one part is "live" and the other
  reverts to simple save/load.
- **Single-user editing is a degenerate case**: when only one person has a
  note open, the same sync engine still applies — the engine doesn't need
  a separate single- vs. multi-user code path.

## Presence

- Every active collaborator (anyone with `edit`/`owner` permission
  currently in the note) is assigned a distinct color for the session,
  consistent with Figma-style multiplayer cursors.
- Each collaborator's live cursor position and text selection are shown to
  everyone else in their assigned color, alongside their name/avatar.
- Presence indicators disappear when a collaborator closes the note or
  disconnects.

## Permission interaction

- **`edit` or `owner`**: full participant. Can type, and their cursor/
  selection broadcasts to everyone else live.
- **`read`-only**: live viewer. Receives the same real-time text and
  frontmatter updates as editors, over the same sync connection, but has
  no cursor broadcast and cannot type — the property panel and body both
  render in a locked state, consistent with the read-only rendering
  defined in sub-project 2, except now the locked content updates live
  rather than being a static load.
- Permission changes (e.g. a share gets revoked) take effect immediately
  on an open session — an active editor whose access is revoked mid-session
  drops to the read-only live-viewer state (or loses the connection
  entirely if all access is revoked), consistent with sub-project 1's rule
  that access is always checked live, never cached from session start.

## Connection handling

- **No offline-first editing in v1.** If a collaborator's connection drops,
  their local editing pauses and the UI shows a "reconnecting" state rather
  than accepting further edits.
- **On reconnect**, the CRDT's inherent merge semantics reconcile any
  locally buffered changes (made in the brief window between disconnection
  and the UI pausing) against the current shared state automatically. This
  requires no dedicated offline-sync architecture — it falls directly out
  of using a CRDT, and is treated as a UX affordance (a status indicator)
  rather than a new subsystem.

## Explicitly out of scope for this sub-project

- **Full offline-first editing** (indefinite local editing with no
  connection, explicit local persistence, long-offline conflict surfacing)
  — a possible future iteration if v1's reconnect-and-merge proves
  insufficient, not part of this design.
- **Version history / undo across sessions** — not addressed here; revisit
  if collaborative editing surfaces a need for point-in-time recovery
  beyond the CRDT's live state.
- **Comments/annotations** — not part of this sub-project's scope.

## Security hardening (audit follow-up, 2026-07-12)

Adopted from the security audit — see
`2026-07-12-security-audit-findings.md`.

### Per-operation permission enforcement (closes: permission checked only at handshake)

- The sync relay validates a connection's live permission on receipt of
  **every** inbound edit operation, not only when the connection is first
  opened. A revocation event (share revoked, `mergeable` changed,
  deactivation) triggers an immediate server-initiated kick or downgrade
  of any affected open socket — the relay does not wait for the socket to
  naturally reconnect or for a periodic recheck. This is what actually
  delivers on the "access is always checked live" guarantee for an
  already-open collaboration session; without it, a revoked editor's
  already-open connection could keep emitting valid edits for some window
  after their access was pulled.

### Presence visibility (closes: identity disclosure to unauthorized viewers)

- Presence identity (name/avatar/cursor) is visible only to users who
  could otherwise see who has access to the vault (i.e., who could see
  its share/membership list) — not to every viewer regardless of their
  relationship to the vault's owner or team. A read-only user with
  individual access to a vault does not automatically get visibility into
  which team members are concurrently editing it.

## Assumptions carried forward (revisit if wrong)

- Collaborator color assignment is per-session (reassigned each time
  someone joins), not a persistent per-user color identity — exact
  assignment scheme is an implementation-time decision.
- The "reconnecting" window during which local edits are buffered is short
  (network blip scale), not designed to tolerate extended offline periods —
  extended disconnects are expected to eventually surface as a full
  disconnect rather than silently buffering indefinitely.
