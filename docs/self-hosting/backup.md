# Backup & Restore Guide for Self-Hosters

Elara stores its state across two locations:
1. **PostgreSQL Database (`db-data` volume)**: Users, teams, access control, metadata, repository indexing, security events, notifications, and vector embeddings.
2. **Disk Filesystem (`elara-data` volume)**: The raw Markdown files in your vaults, attachments, and local repository mirrors *(Note: legacy deployments may have used `chapters-data`)*.

> **CRITICAL**: A database backup alone does **not** preserve your notes. You must back up both the database and the data volume.

---

## 1. Automated / Manual Infrastructure Backup

### Creating a Full Backup

Run the following commands on your host where `docker-compose.yml` is running:

```bash
# 1. Create a timestamped backup directory
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p ./backups/${BACKUP_DATE}

# 2. Dump the PostgreSQL database
docker compose exec -T db pg_dump -U ${POSTGRES_USER:-elara} ${POSTGRES_DB:-elara} > ./backups/${BACKUP_DATE}/elara-db.sql

# 3. Archive the files volume (raw markdown files & vaults)
docker compose run --rm -v elara-data:/data -v $(pwd)/backups/${BACKUP_DATE}:/backup alpine tar czf /backup/elara-data.tar.gz -C /data .

# 4. Save your encryption key and configuration (DO NOT commit to public repos)
cp .env ./backups/${BACKUP_DATE}/env-backup
```

### Automating with Cron

Add a nightly cron job on your host (`crontab -e`):

```cron
0 2 * * * cd /opt/elara && ./scripts/backup.sh > /var/log/elara-backup.log 2>&1
```

---

## 2. Infrastructure Restore Procedure

To restore Elara onto a fresh machine or server:

```bash
# 1. Start the database service first
docker compose up -d db
docker compose exec db pg_isready

# 2. Restore PostgreSQL database
docker compose exec -T db psql -U ${POSTGRES_USER:-elara} -d ${POSTGRES_DB:-elara} < ./backups/<TIMESTAMP>/elara-db.sql

# 3. Restore the data volume (raw markdown notes)
docker compose run --rm -v elara-data:/data -v $(pwd)/backups/<TIMESTAMP>:/backup alpine tar xzf /backup/elara-data.tar.gz -C /data

# 4. Restore your .env configuration (ensuring CREDENTIALS_ENCRYPTION_KEY matches)
cp ./backups/<TIMESTAMP>/env-backup .env

# 5. Start the full application
docker compose up -d
```

---

## 3. Application-Level Instance Backup & Restore

Elara also provides an application-level portable export that can be migrated between environments:

### Exporting via Admin Dashboard
1. Log in as an Administrator (`owner` or `admin`).
2. Navigate to **Admin Settings** -> **Instance Backup**.
3. Click **Export Full Instance Archive (.zip)**.

### Restoring via CLI
Restoring an application-level zip archive must be done against a clean instance:

```bash
docker compose exec app pnpm restore-backup /path/to/backup.zip
```
