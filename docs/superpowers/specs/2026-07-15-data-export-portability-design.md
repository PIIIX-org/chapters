# Chapters — Data Export & Portability

Sub-project 7 of 7. Structural design only — no implementation detail.

## Depends on

- Sub-project 1 (Auth & Vault/Sharing model): export/import respects the
  same access-resolution rule and permission levels; the share list in an
  export archive is expressed in terms of that spec's `VaultShare` model.
- Sub-project 2 (Editor): exported/imported notes are exactly the OKF file
  tree that spec already treats as the source of truth. Imported notes go
  through the same shared server-side OKF validation function as any other
  write — no import-specific bypass of that guarantee.

## Why this exists

The README's core promise is "no proprietary database holding your notes
hostage" — notes are already plain OKF markdown files on disk (per the
architecture in sub-project 6's spec), so that promise is technically true
at the storage layer. What's missing is a *user-facing* way to get that
data out without direct server/filesystem access. This sub-project closes
that gap.

## Scope

**Core (this spec):**
- Per-note download
- Per-vault download (zip archive)
- Shareable, expiring download link
- Cross-instance import (the reverse of export, designed together so the
  formats match)
- Full-instance admin backup

**Explicitly deferred, tracked but not designed here:**
- **Cloud storage integrations** (Google Drive, Dropbox, S3, etc.) — each
  provider needs its own OAuth flow and API integration; a separate
  technical surface from export itself, not a detail of it.
- **Automated/scheduled recurring backups** — needs job-scheduling
  infrastructure; more naturally a convenience layer built on top of the
  manual export/import primitives defined here, once those exist.

## Export

### Permission

Exporting a vault (in any form — per-note, per-vault, or via a share link)
requires `edit` or `owner` permission on that vault, not merely `read`.
Read-only viewers can see content in the app but cannot take a portable
copy of it — export is treated as a stronger action than viewing, since a
downloaded archive persists even after the viewer's access is later
revoked, which plain in-app viewing does not.

### Per-note export

A single note exports as one `.md` file, exactly as stored (frontmatter +
body) — no transformation.

### Per-vault export

A zip archive containing two things, kept separate:
- The vault's exact OKF file tree (notes + frontmatter), untouched —
  identical to what's already on disk. Note files are never mixed with
  export-specific metadata.
- A sidecar manifest file (e.g. `manifest.json`) holding everything that
  isn't part of the OKF file format itself: the vault's name, its
  `mergeable` flag, and its current share list (grantee, grantee type,
  permission level).

Keeping the manifest separate from the notes preserves the "plain files,
always" guarantee for the content itself — the manifest is instance
metadata, not knowledge content.

### Shareable download link

A vault owner (or anyone with `edit`/`owner`, consistent with the export
permission rule) can generate a signed URL for a specific export. The link:
- Expires after a set window (exact duration is an implementation-time
  decision, not fixed here).
- Can be revoked manually before it expires.
- Grants download access to anyone who has the link during its valid
  window — same trade-off inherent to any "share this download link"
  feature, deliberately time-boxed so a forgotten link doesn't become a
  standing, unguarded backdoor to that export.

## Import

- Any active user can trigger an import by uploading an export archive.
  They become the owner of the newly created vault — consistent with the
  existing rule that any active user can create vaults.
- Vault-level settings (name, `mergeable` flag) are recreated from the
  archive's manifest.
- **Share list resolution**: each entry in the manifest's share list is
  matched by email against the destination instance's existing user
  accounts.
  - A match is re-shared automatically at the same permission level
    recorded in the manifest.
  - An unmatched entry is skipped — no new account is silently created —
    and reported back to the importer as "these people need manual
    re-sharing on this instance."
- **Notes** are recreated via the same shared server-side OKF-validation
  write path used everywhere else in the product (editor saves, MCP
  writes, per sub-project 2's hardening). Import gets no special-cased
  validation bypass.

## Full-instance admin backup

- Admin-only action.
- Bundles every vault's export (notes + manifest, as defined above)
  together, **plus** a full account-layer dump: all Users, Teams,
  TeamMemberships, VaultShares, MCPConnections (hashed tokens only — raw
  secrets are never recoverable, consistent with sub-project 1's token
  hardening), and the security/audit event log.
- Restoring this backup on a fresh instance recreates full state — content
  *and* who owns/can access what. A backup that restores notes but no
  accounts or permissions isn't a real disaster-recovery restore, so the
  account layer is included by design, not treated as optional.

## Explicitly out of scope for this sub-project

- Cloud storage integrations (see "Scope" above).
- Automated/scheduled recurring backups (see "Scope" above).
- Partial/selective restore from a full-instance backup (e.g. restoring
  just one vault out of a full backup) — the backup format supports this
  in principle (it's just per-vault bundles plus an account dump), but the
  restore *tooling* for partial restores isn't designed here.

## Assumptions carried forward (revisit if wrong)

- Export link expiry duration is an implementation-time tuning decision.
- Import always creates a *new* vault; this spec does not define an
  "import into / overwrite an existing vault" flow.
- Manifest format (e.g. `manifest.json` vs. another structured format) is
  an implementation-time decision — the requirement here is only that
  vault metadata and share-list data live outside the note files
  themselves, not the exact serialization.
