# Plan — Sub-project 5: Real-time collaboration (backend)

Spec: `2026-07-11-realtime-collaboration-design.md`. Backend scope: the
sync relay, persistence, and enforcement; cursors/UI come in the UI phase.

## Implementation-time decisions

- **Hocuspocus 4 as its own Server on a dedicated port** (`COLLAB_PORT`,
  default 3001) in the same process. A hand-mounted upgrade handler on
  the Fastify server was tried first and abandoned — Hocuspocus 4's
  crossws internals never completed the handshake through a foreign
  upgrade path, and its native Server is the battle-tested route.
  Document name = `<vaultId>/<type>/<name>`. Docs must exist (REST
  create first); Y structure: `Y.Text('body')` + `Y.Map('frontmatter')`.
- **Persistence through the shared write path**: `onStoreDocument`
  (debounced, `COLLAB_DEBOUNCE_MS`, default 2s) extracts body+frontmatter
  and calls `notes/store.updateNote` — same OKF validation, link sync,
  and embedding scheduling as every other write. Invalid collab state
  (bad frontmatter) is logged and NOT persisted; disk keeps the last
  valid version.
- **Editors only on the CRDT socket.** `onAuthenticate` (session token)
  requires `edit`/`owner`. Per-operation enforcement:
  `beforeHandleMessage` re-resolves access live on every inbound message
  (small indexed queries; editors batch updates).
  <!-- ponytail: per-message DB re-check; swap to event-invalidated per-connection state if profiling demands -->
- **Read-only live viewers get SSE, not a Yjs connection** (documented
  deviation from "same sync connection"): `GET .../notes/<path>/live`
  streams the note's state on every change. Equivalent behavior (locked
  content updating live), and it structurally enforces the audit's
  presence rule — viewers never receive awareness/identity data at all,
  and never send a cursor. Presence flows only between active editors,
  who already reveal identity to each other by editing.
- **Server-initiated kick**: an in-process permission event bus
  (`sync/permission-events.ts`). Share create/update/revoke, team
  member add/remove, team delete, ownership transfer, and deactivation
  emit events; the relay and the SSE hub re-resolve affected
  connections immediately — kick or downgrade, no waiting for reconnect.
  <!-- ponytail: in-process bus; needs pg NOTIFY or similar if multi-process -->
- **Reconnect**: client concern (CRDT merges on reconnect by nature);
  no offline-first server work in v1, per spec.

## Tests

1. Two editors converge (provider A types, provider B sees it).
2. Debounced store: OKF file on disk reflects collab edits, embedding/
   links pipeline fired.
3. Read-only user: CRDT connection refused; SSE stream delivers initial
   state + live update.
4. Revocation mid-session: share deleted → editor's socket killed and
   further edits impossible; SSE viewer dropped.
5. Frontmatter edited via Y.Map persists through shared validation.
