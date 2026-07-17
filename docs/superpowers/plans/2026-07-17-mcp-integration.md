# Plan — Sub-project 6: MCP integration (backend)

Spec: `2026-07-12-mcp-integration-design.md`. The connection/token model
already exists (sub-project 1); this delivers what a connection can do.

## Implementation-time decisions

- **Transport**: official MCP TS SDK, Streamable HTTP in stateless JSON
  mode at `POST /mcp` on the main Fastify server — a fresh McpServer +
  transport per request, auth via `Authorization: Bearer <token>` →
  `resolveMcpToken` (live checks; revoked/expired/deactivated never
  resolve).
- **Tools** (all permission-checked live per call, same rules as the UI):
  `list_vaults`*, `browse_vault`, `read_note`, `create_note`,
  `edit_note`, `delete_note` (soft), `search` (+`everywhere`* flag),
  `graph` (+`merged`* variant), `note_history`, `revert_note`.
  Starred = account-wide surfaces, **hard-rejected** for vault-scoped
  connections (audit rule — never silently narrowed).
- **Writes flow through the CRDT engine**: `edit_note` opens a Hocuspocus
  direct connection (same instance as human editors — the AI edit is a
  visible participant), mutates `Y.Text('body')`/`Y.Map('frontmatter')`,
  and persistence flows through the same debounced store path. If the
  collab server isn't running (degenerate deployments/tests), falls back
  to the direct store write — same validation either way.
- **Audit trail**: `note_revisions` table — every store write records
  actor (`user`/`mcp`/`collab` + id) and the full prior-state-free
  snapshot (frontmatter+body), enough to revert. History+revert require
  `edit` (audit rule: read-only sees current state, not history). **Hard
  purge** of a single revision: vault owner or admin, security-logged.
- **Rate limiting** (audit: structural, not deferred): per-connection
  in-memory token bucket, `MCP_RATE_LIMIT` req/min (default 120) → MCP
  error when exceeded.
  <!-- ponytail: in-memory per-process bucket; DB/redis if multi-process -->
- **Bulk operations**: v1 exposes single-note writes only, so the
  audit's "bulk ops need human confirmation" holds vacuously — any
  future bulk tool must add an explicit confirmation flow.
- **Prompt-injection stance** (spec): note content returned by tools is
  data; no sanitization attempted, responsibility documented for MCP
  clients in the tool descriptions.

## Tests

SDK Client over HTTP against the real server: tools/list; read/browse;
create+edit (verify CRDT path when collab up, file on disk after);
scope hard-reject (vault token → list_vaults error); revoked token →
401; share revoked mid-session → next call fails; history grows per
write with actors attributed; revert restores; purge removes a revision;
rate limit trips.
