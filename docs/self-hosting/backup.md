# Backup & Restore Guide for Self-Hosters

Chapters stores its state across two locations:
1. **PostgreSQL Database (`db-data` volume)**: the authority for every note (body, frontmatter, every revision; since ADR-003 S2a), plus users, teams, access control, metadata, repository indexing, security events, notifications, and vector embeddings.
2. **Disk Filesystem (`chapters-data` volume)**: attachments (`assets/`, which have no database rows), local repository mirrors, and the Markdown files of your vaults. Since S2a those files are a projection Elara writes from the database after each save: readable, greppable, but not read back. A hand or `git` edit of a `.md` file is not imported; Elara copies it to `.conflicts/` the next time it writes that path (see "Files Elara set aside" below).

> **CRITICAL**: The database dump is the backup that matters for notes: the files alone no longer rebuild a vault exactly (revisions and anything not yet projected are only in the database). Back up both: the database, and the data volume for attachments.

---

## 1. Automated / Manual Infrastructure Backup

### Creating a Full Backup

Run the following commands on your host where `docker-compose.yml` is running:

```bash
# 1. Create a timestamped backup directory, readable by you only (the dump holds password and token hashes)
umask 077
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p ./backups/${BACKUP_DATE}

# 2. Dump the PostgreSQL database
docker compose exec -T db pg_dump -U ${POSTGRES_USER:-elara} ${POSTGRES_DB:-elara} > ./backups/${BACKUP_DATE}/chapters-db.sql

# 3. Archive the files volume (raw markdown files & vaults)
docker compose run --rm -v chapters-data:/data -v $(pwd)/backups/${BACKUP_DATE}:/backup alpine tar czf /backup/chapters-data.tar.gz -C /data .

# 4. Save your encryption key and configuration (DO NOT commit to public repos)
cp .env ./backups/${BACKUP_DATE}/env-backup
```

### Automating with Cron

Add a nightly cron job on your host (`crontab -e`):

```cron
0 2 * * * cd /opt/chapters && ./scripts/backup.sh > /var/log/chapters-backup.log 2>&1
```

---

## 2. Infrastructure Restore Procedure

To restore Chapters onto a fresh machine or server:

```bash
# 1. Start the database service first
docker compose up -d db
docker compose exec db pg_isready

# 2. Restore PostgreSQL database
docker compose exec -T db psql -U ${POSTGRES_USER:-elara} -d ${POSTGRES_DB:-elara} < ./backups/<TIMESTAMP>/chapters-db.sql

# 3. Restore the data volume (raw markdown notes)
docker compose run --rm -v chapters-data:/data -v $(pwd)/backups/<TIMESTAMP>:/backup alpine tar xzf /backup/chapters-data.tar.gz -C /data

# 4. Restore your .env configuration (ensuring CREDENTIALS_ENCRYPTION_KEY matches)
cp ./backups/<TIMESTAMP>/env-backup .env

# 5. Start the full application
docker compose up -d
```

---

## 3. Application-Level Instance Backup & Restore

Elara also writes a single-zip instance backup that restores onto another machine with the same ids. Get one from **Admin** → **Instance backup** → **Download backup** (`GET /api/admin/backup`), or from the scheduled backups (`BACKUP_LOCAL_PATH` / S3, **Run backup** for one now).

### What the archive holds

Format 2 (since #409): `backup.json` (format version, time, row count per table, and since #493 the SHA-256 and size of every other entry under `parts`), one `db/<table>.jsonl` per table (one row per line, as stored), and the files under `vaults/<vault id>/`: `notes/<path>.md` (live notes), `trash/<note id>.md` (trashed notes) and `assets/<file>` (attachments; they have no database rows). All tables are read in one database snapshot, and since ADR-003 S2a every note file in the archive is rendered from its row in that snapshot (with its frontmatter key order), never read from disk: a note whose file is still being written, or was edited by hand, is archived as the database has it. Archives made by earlier releases read the files and left out the ones that no longer matched their row (`notesFromRow` in `backup.json`); the restore plan still reports those.

| In the archive | Left out, and how it comes back |
| :--- | :--- |
| users (password hashes; TOTP secrets as stored), MFA backup codes (hashed) | sessions and email verification / reset tokens: everyone signs in again |
| teams, memberships, vaults (including trashed ones), vault shares, graph preferences, vault preferences, graph perspectives | export links: create a new one |
| notes (live and trashed, same ids), every revision | note links: rebuilt from the note bodies by the restore |
| repositories (git credentials and webhook secrets stay encrypted), repository shares, graph preferences, sync tokens (hashed) | the repository file index (files, imports, symbols): the next sync rebuilds it, see below |
| MCP tokens (hashed, with access level, allow-list, expiry, revocation), security events, notifications, the instance's MFA mandate | embeddings and semantic edges: computed on boot; collab (CRDT) state: rebuilt from the note when it is opened |

> The archive holds password hashes, token hashes, TOTP secrets and every note in plain text. Treat it like the database itself, and keep a downloaded copy owner-only too. Restoring repositories needs the same `CREDENTIALS_ENCRYPTION_KEY` (keep it with the backup, section 1 step 4).

Scheduled backups (`BACKUP_LOCAL_PATH`) are written with mode `600` in a directory with mode `700`, whatever the server's umask (#493): only the user the server runs as (`node` in the image) can read them. Each file is written to a temporary name with that mode first and renamed when complete, so a crash never leaves a half-written `elara-backup-*.zip`. Backups written by earlier releases were world-readable (`644`): each backup run also sets every `elara-backup-*.zip` already in the directory to `600`, so they are tightened by the first backup after the upgrade (run one with **Run backup** to do it now). If the server can't change the directory's or an older file's mode (a mount owned by another user), the backup still runs and the server logs a warning; the new file is still `600`. Copying backups elsewhere (`docker cp`, rsync) is up to you to keep private. The download from the admin page is sent with `cache-control: no-store`, so no browser or proxy cache keeps a copy; the saved file lands wherever your browser puts it.

A scheduled backup that fails, whether building the archive (the database or a vault file could not be read) or writing it to a destination, shows as the last status `error` under **Admin** → **Instance backup** (`GET /api/admin/backup/status`, `lastError`), and the next scheduled attempt is a full `ELARA_BACKUP_INTERVAL_HOURS` later (#771). A failed build is reported as `Building the backup archive failed (<code>)`, with the file error code (for example `EACCES`) or the database's SQLSTATE (for example `42501`): the original error can name a note's path, so it goes to the app's log only (a `[backup] building the archive failed:` line, for scheduled and **Run backup** runs alike; for a database error, the driver's message and code without the query). The monitoring report names it `BackupBuildError` with that code. **Run backup** after fixing the cause to check it.

### Restoring via CLI

The CLI runs inside the app container, so the server must be running (`docker compose up -d`) on the new, empty database and data volume:

```bash
# Check the archive and see the plan, writing nothing:
docker compose exec app pnpm restore-backup --dry-run /path/to/backup.zip
# Restore:
docker compose exec app pnpm restore-backup /path/to/backup.zip
# Then restart the app: embeddings are only computed when the server starts.
docker compose restart app
```

The restore runs in three steps:

1. **Validate**: a readable zip, a format this version knows, every entry with the SHA-256 and size `backup.json` lists for it (nothing missing, nothing added), every table file present with the row count `backup.json` names, well-formed rows, and every row's parent (vault of a note, note of a revision, repository of a pinned token, ...) in the archive. A damaged, truncated, incomplete or modified archive is refused with the reason and the entry, and nothing is written, e.g. `Refusing to restore: vaults/<id>/notes/ideas/x.md does not match its SHA-256 in backup.json: the archive was changed or damaged after the backup`. The digests catch damage and accidental edits, not a deliberate forgery: whoever can rewrite the archive can rewrite `backup.json` too, so keep the archive where only you can write it. An archive made before #493 has no digests: it restores, with a warning in the plan that only the zip's own checksums were checked.
2. **Plan**: per table, how many rows are in the archive, how many will be restored and how many are already there (by id); the same for note, trash and attachment files. Conflicts refuse the restore, and nothing is written. It prints counts and messages only, never a secret, hash or note; an unexpected error prints the database's message and code only.
3. **Apply**: every row in one transaction; files are written atomically inside it, so a file that can't be written rolls the rows back, and the files this run created are removed again. A file the restore replaced keeps the archive's version: when the data volume was kept, the plan warns how many note or trash files on disk differ and will be replaced (attachments that differ are kept, also with a warning).

It runs on an empty instance (no users). Any other instance is refused (`Refusing to restore: this instance already has N user(s) ...`), as is an archive whose rows would clash with different existing rows (same email, same live note path). Run it again on an instance already restored from the same archive and it writes nothing (`Already restored from this archive at ...`): the restore commits completely or not at all, so there is nothing to resume, and writing again would bring back what was deleted since (shares, purged notes, rotated MFA backup codes). The one thing it repairs is a missing generated `index.md`, in case the process stopped right after the commit. After a failed restore the instance is still empty: fix the cause and run it again.

Sessions are not restored: everyone signs in again. MCP tokens are restored with their hashes, so account, vault and repository tokens keep working with the same token string, access level, allow-list, expiry and revocation; the only tokens left out are the ones a plan warning names (repository-pinned tokens in a format-1 archive, below). The CLI's closing message says the same.

Until the app restarts, semantic search finds nothing; the restart computes the embeddings in the background. Restored repositories come back with an empty file index and no last sync: git repositories are re-indexed by the next poll, local-folder repositories with **Sync** on the repository, agent-push repositories on the agent's next push.

### Older archives (format 1)

Archives written before #409 (an `account-dump.json`, no `backup.json`) still restore, with what they have: users, teams, vaults, shares, MCP tokens, security events, notifications, live notes and attachments. They have no SHA-256 digests (the plan warns). They never held the trash, revision history, repositories or TOTP secrets, so after such a restore:

- each note has one `create` revision and a new id (the same id on every restore of that archive);
- tokens pinned to a repository are left out, since the archive has no repositories (the plan warns how many); account and vault tokens keep working;
- users who had MFA on can't sign in until it is cleared, after which they set it up again:

  ```bash
  docker compose exec -T db psql -U ${POSTGRES_USER:-elara} -d ${POSTGRES_DB:-elara} -c "UPDATE users SET mfa_enabled_at = NULL WHERE mfa_enabled_at IS NOT NULL AND totp_secret IS NULL"
  ```

---

## 4. Verify After Restoring

After either restore path, check that every note file on disk can be opened and matches the database:

```bash
docker compose exec app pnpm check-notes --wait-idle
```

It prints one `BROKEN` line per problem: a missing file (`missing-file`), damaged frontmatter (`unparseable`), a file whose frontmatter or body differs from the database row (`frontmatter-mismatch`, `body-mismatch`, e.g. when the database and the files were restored from different points in time), or a `.md` file no note owns (`orphan-file`; the next start moves it to `.orphans/`). It exits with code 1 if there are any. A clean restore ends with `checked N notes, 0 broken`.

Files are written by a background projector after each save, so the check compares a file only once its projection has caught up and lists the rest as pending; `--wait-idle[=<seconds>]` waits for it first (default 60 s), `--fail-on-pending` turns anything still pending into a failure. It only reads.

### The doctor

For a deeper check than `check-notes`, run the doctor. It compares every copy of every note with the database row: the file, the latest revision, the editor state (`.crdt` files and `note_crdt`), the full-text index, the embedding, the link index and the projection state:

```bash
docker compose exec app pnpm doctor                 # text report, exit 1 on any problem
docker compose exec app pnpm doctor --report        # the same as JSON
docker compose exec app pnpm doctor --repair        # queue the safe repairs, then run it again
```

It only reads unless you pass `--repair`, and `--repair` never changes a note: it asks the server to write a note's file or a folder's `index.md` again (a file Elara did not write is copied to `.conflicts/` first), to rebuild a note's links, or to compute its embedding again. Run the doctor again after a minute to see them done. Anything it cannot repair (for example `revision-missing` or a `crdt-*` class) is a bug: open an issue with the report. Run it while the instance is quiet: an edit in progress can show up for a moment.

### Last resort: rebuild notes from the files

The database is the backup that matters: it alone holds revisions, editor history and edits not yet written to a file. If it is lost and no dump can be restored, `rows-from-files` rebuilds the missing notes from the `.md` files in the data volume (each note gets one `create` revision; history is gone):

```bash
docker compose stop app
docker compose run --rm app pnpm rows-from-files --dry-run                     # see what it would do
docker compose run --rm app pnpm rows-from-files --owner you@example.com       # do it
docker compose start app
```

It refuses to run while the app is up (exit 2). It never overwrites a note that exists: one whose file differs is listed and left alone. Folders whose vault no longer exists are skipped unless you pass `--owner <email>`, which recreates them as `Restored <id>` vaults owned by that user (rename and share them afterwards). Run `pnpm doctor` afterwards.

### Files Elara set aside

Elara never silently overwrites or deletes a note file it did not write itself:

- `vaults/<id>/.conflicts/<path>.<time>.md`: a file whose bytes differed from what Elara last wrote there (a hand or `git` edit, a file a power loss truncated), copied before Elara rewrote or removed it. The database holds the note; compare and copy back what you need by hand or with `edit_note`.
- `vaults/<id>/.orphans/<path>.md`: a `.md` file no note and no directory index owns (moved there at boot, after the files caught up).
- `vaults/<id>/.migration/<date>/unparseable/`: files the S2a migration could not parse (migration.md).

These folders are never read as notes. Delete them when you no longer need them.

---

## 5. Rolling Back to an Older Release

Database migrations only run forward. Going back to an older image keeps the newer schema, so take a backup (section 1) before every upgrade: restoring it is the clean way back. If you run older code against the newer schema instead, apply the step below for every release you roll back over.

- **Migrations 0019 and 0020 (MCP token capabilities, #548, #549)** add `mcp_connections.access` as `NOT NULL` and then drop its default. Code from before 0019 does not set `access` when it mints a token, so every new MCP connection fails until the column has its default back. Run this before starting the older code:

  ```bash
  docker compose exec -T db psql -U ${POSTGRES_USER:-elara} -d ${POSTGRES_DB:-elara} -c "ALTER TABLE mcp_connections ALTER COLUMN access SET DEFAULT 'write'"
  ```

  The older code does not read `access` or `allowed_tools`, so read-only and allow-listed tokens get every tool of their scope while it runs. Revoke any of those you would not trust with more. Note the time you rolled back.

  When you upgrade again, the newer code runs no migration (0019 and 0020 are already applied) and always names a level, so the restored default does no harm. Two things to put back:

  ```bash
  # Account tokens minted while rolled back got 'write'; 0019 gives account tokens 'admin'.
  docker compose exec -T db psql -U ${POSTGRES_USER:-elara} -d ${POSTGRES_DB:-elara} -c "UPDATE mcp_connections SET access = 'admin' WHERE scope = 'account' AND created_at > '<rollback time, e.g. 2026-10-20T12:00:00Z>'"
  # Back to the schema 0020 left: no default, so an insert that forgets the level fails.
  docker compose exec -T db psql -U ${POSTGRES_USER:-elara} -d ${POSTGRES_DB:-elara} -c "ALTER TABLE mcp_connections ALTER COLUMN access DROP DEFAULT"
  ```

  Pinned tokens minted while rolled back keep `write`. The newer code lists and runs on them only what the user's permission on the pin allows, so a read-only member's token is not widened.

- **Migration 0021 and the S2a store (ADR-003).** 0021 is additive: it adds columns with lasting defaults, a trigger that only maintains `notes.seq`, new tables whose foreign keys cascade, and two marker columns. Older code runs on it with **no SQL**. Rolling back from an S2a release to the one before it, keeping the data written since, is supported for one release (code-only rollback). Do it when nobody is typing in an editor:

  ```bash
  # 1. Stop the new app (graceful: it stores every open editor's typing first).
  docker compose stop app
  # 2. With no server running, write every note file and index.md from the database.
  #    It takes the instance maintenance lock: it refuses to run (exit 2) while any app or
  #    writing CLI is up, and an app started during it refuses to start.
  docker compose run --rm --no-deps app pnpm store-export-legacy
  # 3. Check out the older release, build it and start it. No SQL is needed.
  docker compose up -d --build app
  ```

  The export checks every note file and `index.md` against the database (rewriting one a crash left damaged, after a copy to `.conflicts/`) and finishes any pending link rewrite of a rename. It prints a summary and writes `/data/elara/store-export-legacy-<time>.json`; it exits 1 when a file could not be written (the report lists it with its error): fix that and run it again before step 3. It also refuses (exit 1) while the S2a migration has not finished (failures in `migration-report-*.json`): start the new release until the migration completes, or restore the pre-upgrade backup instead. `.crdt/` needs nothing: S2a kept it current.

  **Rolling forward again** needs nothing either: at boot, the S2a release gives every note the older code created, edited, renamed or restored its projection rows and a revision at its current version, and adopts the files the older code wrote (same content, its key order) without conflict copies. While rolled back, the older release's own defects (#486-#488) are back.
- **Migration 0023 (history events, #479)** is additive: three nullable columns on `note_revisions` (`source_revision_id`, `from_path`, `to_path`). Older code runs on it with **no SQL**. It stops recording restore and rename events and leaves the new columns empty; the events the newer code recorded stay in the history. It also brings back the older revert: it relabels the newest revision `revert` instead of adding one (code with #482 skips relabelling a `restore_point`). When that newest row is an event the newer code recorded (a `rename` or `restore`), the relabelled row keeps its `from_path`/`to_path` and has no `source_revision_id`. Code from before #482 also does not record a delete by the author of the latest revision when the note is unchanged.
- **Migration 0024 (revision order, #825)** is additive: `note_revisions.ord`, numbered from a sequence (its default), so older code records revisions with **no SQL**. Older code lists history by the database clock again, so revisions recorded in the same instant, or after the clock stepped back, can show out of order; the newer code lists every revision in the order it was recorded. An instance backup made by the newer code carries `ord` on every revision, and older code refuses it (`column "ord" is unknown to this version`): restore it with the newer release. A backup made before 0024 restores on the newer release with its revisions numbered in time order.
