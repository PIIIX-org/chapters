# Plan — Sub-project 7: Data export & portability (backend)

Spec: `2026-07-15-data-export-portability-design.md`.

## Implementation-time decisions

- **Zip**: `adm-zip` (read+write, one dep). Archive layout per spec: the
  exact OKF file tree (live notes only — trash excluded) untouched, plus
  a sidecar `manifest.json` (vault name, `mergeable`, share list). User
  grantees recorded by **email** (what import re-matches on); team
  grantees by team name — teams are instance-local, so import always
  reports them for manual re-sharing.
- **Permission**: every export form requires `edit`/`owner` (spec: export
  is stronger than viewing); no-access → 404.
- **Share links**: `export_links` table (token hashed, expiry
  `EXPORT_LINK_TTL_HOURS` default 24, revocable). The download endpoint
  is sessionless by design — anyone with the link inside the window.
- **Import**: multipart upload (`@fastify/multipart`); always creates a
  new vault owned by the importer; notes recreated through
  `createNote` — the same shared OKF validation, no import bypass;
  invalid entries are skipped and reported. Share list matched by email
  against active users → re-shared at recorded permission; unmatched
  reported back, never auto-created.
- **Full-instance admin backup**: admin-only zip — every vault bundle
  plus `account-dump.json` (users incl. password hashes — non-recoverable
  argon2, needed for real disaster recovery; teams, memberships, shares,
  MCP connections hashed-tokens-only, security events, notifications).
  Restore = `pnpm restore-backup <zip>` CLI for a fresh instance
  (endpoint deliberately not exposed; restoring over a live instance is
  not a button). Partial restore: out of scope per spec.

## Tests

Export zip shape (files + manifest, trash excluded); read-only export
rejection; share link: sessionless download, revocation, expiry; import:
new vault owned by importer, validation enforced, matched shares
recreated, unmatched reported; admin backup: contains vault bundles +
account dump, non-admin rejected.
