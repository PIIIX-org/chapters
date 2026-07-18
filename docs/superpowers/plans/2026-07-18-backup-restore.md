# Backup Restore Implementation Plan

Closes a gap in sub-project 7 (`2026-07-15-data-export-portability-design.md`):
`buildInstanceBackup()` (export) was built and shipped, but nothing ever
read a backup back. The original implementation plan called for exactly
this ("Restore = `pnpm restore-backup <zip>` CLI for a fresh instance")
but it was never built.

**Goal:** A CLI that restores a full-instance backup zip onto a fresh
(empty) instance — the disaster-recovery half of the export/backup
feature.

**Why a CLI, not an endpoint:** per the spec's own framing, "restoring
over a live instance is not a button" — this is a deliberate, operator-run
action, not something reachable over HTTP (unlike backup creation, which
is a safe read-only admin action). Same pattern as `pnpm reindex`.

## Design decisions

- **Fresh-instance only, hard refusal, no override flag.** Restore checks
  `users` table row count; anything non-zero aborts with no data touched.
  No `--force` — an instance that genuinely needs restoring over existing
  data is a different, more deliberate operation than this tool covers
  (manually clear tables first, then restore).
- **IDs preserved, not regenerated.** The backup format keeps every
  original UUID (user, team, vault, share, etc.); restoring re-inserts
  rows with their exact original IDs. This is what makes it a true
  restore rather than an import — foreign keys across the dump stay
  intact automatically, and it matches the "fresh instance" assumption
  (no collision risk).
- **Account-layer restore is one transaction**; note restoration (from
  each vault's `.md` files) runs afterward, per-note best-effort — same
  skip-and-report pattern the existing `/import` endpoint already uses
  for OKF validation failures. A transaction around file-tree restoration
  isn't meaningful the same way (disk writes aren't transactional), so
  keeping this phase separate is the honest boundary, not a corner cut.
- **Instance setup is completed as part of restore.** The backup dump
  doesn't include `instanceState` (a deliberate non-change to the
  already-shipped backup format — no need to touch it). Once users are
  restored, restore marks `instanceState.setupCompletedAt` itself, since
  a fresh instance with restored (already-approved) users has no reason
  to run the setup-token flow again.
- **MCP connection rows are restored as historical/metadata record**,
  even though their hashed tokens can never be used again (the raw
  token was never stored). An admin can revoke and reissue if a working
  connection is needed post-restore — restoring the row still preserves
  the audit trail of what existed.

## File structure

- `server/src/export/restore.ts` — core logic, testable independent of
  the CLI: `isInstanceEmpty()`, `restoreBackup(zipBuffer)`.
- `server/src/scripts/restore-backup.ts` — CLI entry point
  (`pnpm restore-backup <path-to-zip>`): reads the file, refuses if the
  instance isn't empty, calls `restoreBackup`, prints a summary.
- `server/test/restore.test.ts` — tests both functions.

## Interfaces

```ts
// export/restore.ts
export interface RestoreResult {
  users: number
  teams: number
  teamMemberships: number
  vaults: number
  vaultShares: number
  mcpConnections: number
  securityEvents: number
  notifications: number
  notesImported: number
  notesSkipped: string[]
}
export async function isInstanceEmpty(): Promise<boolean>
export async function restoreBackup(zipBuffer: Buffer): Promise<RestoreResult>
```

## Tasks

1. `isInstanceEmpty()` + `restoreBackup()` in `export/restore.ts`,
   parsing `account-dump.json` and inserting each table (preserving IDs)
   inside one transaction, then walking `vaults/<id>/*.md` entries and
   recreating notes via the existing shared `createNote` write path
   (same OKF-validation, skip-and-report pattern as `/import`), then
   marking `instanceState.setupCompletedAt`.
   - Test: hand-built synthetic account-dump zip (fresh UUIDs mirroring
     the real dump shape, referencing each other correctly, plus a
     small `vaults/<id>/*.md` tree) restores every table with IDs
     preserved, recreates notes, and marks setup complete.
     `isInstanceEmpty()` returns `false` against the already-populated
     shared test DB (confirms the safety check actually detects
     non-empty — a genuinely fresh-instance test isn't reachable inside
     the shared test database this suite already uses, so this is
     tested at the boundary that's actually testable).
2. `scripts/restore-backup.ts` CLI + `pnpm restore-backup` script entry,
   wiring the safety check before calling `restoreBackup`.
   - Verified by running it live against a real local instance (visual/
     observable test protocol), not a unit test — it's a thin CLI
     wrapper around already-tested logic.

## Self-review

**Spec coverage**: full-instance restore, ID preservation, account+notes
layers, fresh-instance safety, MCP connections restored as records —
all from the sub-project 7 spec's "Full-instance admin backup" section.
Partial/selective restore stays explicitly out of scope, unchanged from
the original spec.
