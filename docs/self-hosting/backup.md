# Backup & Restore Guide for Self-Hosters

Chapters stores its state across two locations:
1. **PostgreSQL Database (`db-data` volume)**: Users, teams, access control, metadata, repository indexing, security events, notifications, and vector embeddings.
2. **Disk Filesystem (`chapters-data` volume)**: The raw Markdown files in your vaults, attachments, and local repository mirrors.

> **CRITICAL**: A database backup alone does **not** preserve your notes. You must back up both the database and the data volume.

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

Format 2 (since #409): `backup.json` (format version, time, row count per table, and since #493 the SHA-256 and size of every other entry under `parts`), one `db/<table>.jsonl` per table (one row per line, as stored), and the files under `vaults/<vault id>/`: `notes/<path>.md` (live notes, as on disk), `trash/<note id>.md` (trashed notes) and `assets/<file>` (attachments; they have no database rows). All tables are read in one database snapshot. A note file that no longer matches its row in that snapshot (a save landed while the backup ran) is left out, and the restore writes that note's file from its row, so every note comes back as of the snapshot. `backup.json` counts these (`notesFromRow`) and the restore plan says how many.

| In the archive | Left out, and how it comes back |
| :--- | :--- |
| users (password hashes; TOTP secrets as stored), MFA backup codes (hashed) | sessions and email verification / reset tokens: everyone signs in again |
| teams, memberships, vaults (including trashed ones), vault shares, graph preferences, vault preferences, graph perspectives | export links: create a new one |
| notes (live and trashed, same ids), every revision | note links: rebuilt from the note bodies by the restore |
| repositories (git credentials and webhook secrets stay encrypted), repository shares, graph preferences, sync tokens (hashed) | the repository file index (files, imports, symbols): the next sync rebuilds it, see below |
| MCP tokens (hashed, with access level, allow-list, expiry, revocation), security events, notifications, the instance's MFA mandate | embeddings and semantic edges: computed on boot; collab (CRDT) state: rebuilt from the note when it is opened |

> The archive holds password hashes, token hashes, TOTP secrets and every note in plain text. Treat it like the database itself, and keep a downloaded copy owner-only too. Restoring repositories needs the same `CREDENTIALS_ENCRYPTION_KEY` (keep it with the backup, section 1 step 4).

Scheduled backups (`BACKUP_LOCAL_PATH`) are written with mode `600` in a directory with mode `700`, whatever the server's umask (#493): only the user the server runs as (`node` in the image) can read them. Each file is written to a temporary name with that mode first and renamed when complete, so a crash never leaves a half-written `elara-backup-*.zip`. Backups written by earlier releases were world-readable (`644`): each backup run also sets every `elara-backup-*.zip` already in the directory to `600`, so they are tightened by the first backup after the upgrade (run one with **Run backup** to do it now). If the server can't change the directory's or an older file's mode (a mount owned by another user), the backup still runs and the server logs a warning; the new file is still `600`. Copying backups elsewhere (`docker cp`, rsync) is up to you to keep private. The download from the admin page is sent with `cache-control: no-store`, so no browser or proxy cache keeps a copy; the saved file lands wherever your browser puts it.

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

Until the app restarts, semantic search finds nothing; the restart computes the embeddings in the background. Restored repositories come back with an empty file index and no last sync: git repositories are re-indexed by the next poll, local-folder repositories with **Sync** on the repository, agent-push repositories on the agent's next push.

### Older archives (format 1)

Archives written before #409 (an `account-dump.json`, no `backup.json`) still restore, with what they have: users, teams, vaults, shares, MCP tokens, security events, notifications, live notes and attachments. They have no SHA-256 digests (the plan warns). They never held the trash, revision history, repositories or TOTP secrets, so after such a restore:

- each note has one `create` revision and a new id (the same id on every restore of that archive);
- tokens pinned to a repository are left out (the plan says how many);
- users who had MFA on can't sign in until it is cleared, after which they set it up again:

  ```bash
  docker compose exec -T db psql -U ${POSTGRES_USER:-elara} -d ${POSTGRES_DB:-elara} -c "UPDATE users SET mfa_enabled_at = NULL WHERE mfa_enabled_at IS NOT NULL AND totp_secret IS NULL"
  ```

---

## 4. Verify After Restoring

After either restore path, check that every note file on disk can be opened and matches the database:

```bash
docker compose exec app pnpm check-notes
```

It prints one `BROKEN` line per problem: a missing file (`missing-file`), damaged frontmatter (`unparseable`), or a file whose frontmatter or body differs from the database row (`frontmatter-mismatch`, `body-mismatch`, e.g. when the database and the files were restored from different points in time). It exits with code 1 if there are any. A clean restore ends with `checked N notes, 0 broken`.

If someone is editing while it runs, a note being saved at that moment can show up as a mismatch once. Run the check again before acting on a single mismatch.

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

- **Migration 0021 (ADR-003 store schema)** is additive: it adds columns with lasting defaults, a trigger that only maintains `notes.seq`, new tables whose foreign keys cascade, and two marker columns. Older code runs on it with **no SQL**. Before the store migration itself ships, see [migration.md](migration.md) for the read-only dry run that reports what it will do to your notes.
