# Chapters Self-Hosting & Production Deployment Checklist

Before going public or admitting production users, verify each of the following configuration requirements.

---

## 1. Secrets & Credentials Pre-Flight

- [ ] **`CREDENTIALS_ENCRYPTION_KEY`**
  - **Why**: Used to encrypt third-party git repository tokens, SSH keys, and webhook secrets.
  - **Format**: 64-character hex string (32 bytes).
  - **Command**: `openssl rand -hex 32`
  - **Warning**: Unset = private repository credentials cannot be stored. Back this up securely; changing it renders previously stored credentials unrecoverable.

- [ ] **`POSTGRES_PASSWORD`**
  - **Why**: Database authentication password.
  - **Warning**: Must be set in `.env` **before** the `db-data` volume is initialized for the first time. Changing it in `.env` afterwards will cause authentication failure unless rotated inside PostgreSQL.

- [ ] **`SETUP_TOKEN`**
  - **Why**: One-time bootstrap token used to register the initial administrator account on `/setup`.
  - **Recommendation**: Set explicitly in `.env` (`openssl rand -hex 16`) or retrieve from `docker compose logs app` upon initial start.

---

## 2. Email Delivery (SMTP)

- [ ] **`SMTP_HOST`**
- [ ] **`SMTP_PORT`** (usually 587 or 465)
- [ ] **`SMTP_USER`**
- [ ] **`SMTP_PASS`**
- [ ] **`SMTP_FROM`** (e.g. `Chapters <noreply@yourdomain.com>`)

> **CRITICAL**: If `SMTP_HOST` is unset, outgoing emails are captured in memory and **never delivered**. Users will not receive signup verification or password reset links.

---

## 3. Network & Reverse Proxy

- [ ] **Reverse Proxy / TLS**: Route incoming HTTPS traffic to port `3000`.
- [ ] **WebSocket Proxying**: Ensure your reverse proxy (Caddy / Nginx / Traefik) passes the `Upgrade` header on `/collab`:
  ```nginx
  location /collab {
      proxy_pass http://localhost:3000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "Upgrade";
      proxy_set_header Host $host;
  }
  ```
- [ ] **`CORS_ORIGIN`**: Leave empty for standard single-origin hosting. If using a dedicated domain for an external API consumer, configure the allowed origin URL.

---

## 4. Node & Runtime Environment

- [ ] **Node Version**: When running natively without Docker, ensure Node `>=24.0.0` is installed (pinned in [`.nvmrc`](file:///.nvmrc)). Run `nvm use`.
- [ ] **Vector Extension**: PostgreSQL must have `pgvector` enabled (included by default in `pgvector/pgvector:pg17` image).

---

## 5. Monitoring restarts

Work queued in memory (embeddings, code extraction, note edits inside the collaboration debounce) does not survive a restart, so you want to know when one happens. `GET /health` needs no login and answers:

```json
{
  "status": "ok",
  "startedAt": "2026-10-16T09:12:03.118Z",
  "bootId": "0199ec5a-8a2e-7c41-9d3b-5f0e2a7c1b44",
  "version": "3f1c2d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d",
  "lastShutdown": "graceful"
}
```

| field | meaning |
|---|---|
| `status` | `ok`; when Postgres is unreachable the answer is HTTP `503` with `status: "error"` instead |
| `startedAt` | when this server process started |
| `bootId` | a new random id for every process (time-ordered, so a later boot sorts after an earlier one). **If it changed, the app restarted.** |
| `version` | the commit the image was built from; `null` for an image built without the `ELARA_VERSION` build arg (a plain `docker compose build`) |
| `lastShutdown` | how the **previous** process ended: `graceful` (it finished a clean `SIGTERM` shutdown: `docker compose restart`/`stop`, a redeploy), `unclean` (it was killed or crashed before finishing one: out of memory, `SIGKILL`, an uncaught error, or a shutdown that outlasted Docker's stop timeout), `unknown` (no record: the first start on this data volume) |

`lastShutdown` comes from `lifecycle.json` in `DATA_DIR`; it needs the data volume to persist between containers, which it must anyway for your notes. Each start also prints one JSON line to `docker compose logs app`: `{"event":"boot", ..., "lastShutdown": ..., "previous": {...}}`.

- [ ] **Watch it from outside the host.** Poll `/health` every few minutes and alert when `bootId` changes or when it fails twice in a row. Treat a missing `bootId` (an image older than these fields) as unknown rather than as a change. The Elara project does this for its own instance with a scheduled GitHub Actions workflow, [`.github/workflows/uptime.yml`](../../.github/workflows/uptime.yml) running [`.github/scripts/uptime-monitor.mjs`](../../.github/scripts/uptime-monitor.mjs) (plain Node, `--url https://your.host --state-file state.json` prints the alerts as JSON without touching GitHub).
- [ ] **An `unclean` restart deserves a look**: `docker inspect <app container> --format '{{.State.OOMKilled}} {{.RestartCount}}'` and the app log before the boot line.
