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
- [ ] **`ELARA_TRUST_PROXY`** (#911): the reverse proxy's address or CIDR as the app sees it, comma-separated for several. Without it every request reaches the app from the proxy, so all users share one rate-limit bucket (1000 requests a minute, 10 a minute on login, setup and password reset) and one login lockout, and the security events record the proxy instead of the client. With it, a request from a listed address has its client read from `X-Forwarded-For`; from any other address the header is ignored, so a client cannot choose its own address.
  - The proxy must append the client's address: nginx `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (in every `location`, `/collab` included); Caddy and Traefik do it by default.
  - **Stock `docker-compose.yml`, proxy on the same host** (or in a container on Docker's default networks): publish the app on loopback only, `APP_PORT=127.0.0.1:3000`, and set `ELARA_TRUST_PROXY=172.16.0.0/12`. Docker hands the proxy's connections to the container from its bridge network (the network's gateway for a proxy on the host), and the default bridge networks are in `172.16.0.0/12`. If your Docker uses other address pools, use the app network's subnet: `docker network inspect <project>_default --format '{{(index .IPAM.Config 0).Subnet}}'`.
  - **Check it**: before setting it, `docker compose logs app` shows `"remoteAddress"` in each request line: the proxy's address, the one to trust. After setting it and restarting, the same field shows each client's own address.
  - Never `true`, `*`, `0.0.0.0/0` or a hop count: they would trust any client that reaches the port, and the server refuses them with a warning at boot (and trusts no one). Leave it unset when nothing sits in front of the app.
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
  "lastShutdown": "graceful",
  "previousBootId": "0199ec4f-1b07-7a90-8c62-3e1d4f5a6b7c"
}
```

| field | meaning |
|---|---|
| `status` | `ok`; when Postgres is unreachable the answer is HTTP `503` with `status: "error"` instead |
| `startedAt` | when this server process started |
| `bootId` | a new random id for every process (time-ordered, so a later boot sorts after an earlier one). **If it changed, the app restarted.** |
| `version` | the commit the image was built from; `null` for an image built without the `ELARA_VERSION` build arg (a plain `docker compose build`). Set `ELARA_HEALTH_HIDE_VERSION=true` in `.env` to leave it out of `/health` if you do not want to publish which build you run (any value other than `true` or `false` keeps it shown and logs a warning at start) |
| `lastShutdown` | how the **previous** process ended: `graceful` (it finished a clean `SIGTERM` shutdown: `docker compose restart`/`stop`, a redeploy), `unclean` (it was killed or crashed before finishing one: out of memory, `SIGKILL`, an uncaught error, a shutdown that outlasted Docker's stop timeout, or a `SIGTERM` that arrived while the app was still starting up; or the data volume went read-only while it ran, so its clean stop could not be recorded), `unknown` (no trustworthy record: the first start on this data volume, or a data volume the app could not write) |
| `previousBootId` | the `bootId` of the process `lastShutdown` is about; `null` when `lastShutdown` is `unknown`. If it is not the `bootId` you saw last, more than one restart happened since you looked |

`lastShutdown` comes from `lifecycle.json` in `DATA_DIR`; it needs the data volume to persist between containers, which it must anyway for your notes. It assumes one Elara process per data volume (the shipped compose file runs one). When the app cannot write that file (a full or read-only volume), it reports `unknown` and logs a warning rather than guess. If the volume was read-only, the first start after it is writable again reports `graceful` or `unclean`, from the record the last process before the read-only period left: `graceful` if it stopped cleanly before the volume went read-only, `unclean` if the volume went read-only while it was running (it could not record its clean stop). `previousBootId` is that older process, so if you checked during the read-only period it is not the `bootId` you saw last: treat it like any other "more than one restart" case. Each start also prints one JSON line to `docker compose logs app`: `{"event":"boot", ..., "lastShutdown": ..., "previous": {...}, "markerError": null}`.

- [ ] **Watch it from outside the host.** Poll `/health` every few minutes and alert when `bootId` changes or when it fails twice in a row. Treat a missing `bootId` (an image older than these fields) as unknown rather than as a change. The Elara project does this for its own instance with a scheduled GitHub Actions workflow, [`.github/workflows/uptime.yml`](../../.github/workflows/uptime.yml) running [`.github/scripts/uptime-monitor.mjs`](../../.github/scripts/uptime-monitor.mjs) (plain Node, `--url https://your.host --state-file state.json` prints the alerts as JSON without touching GitHub). Make sure you would notice if the monitor itself stopped: it posts a weekly check-in for that reason.
- [ ] **An `unclean` restart deserves a look**: `docker inspect <app container> --format '{{.State.OOMKilled}} {{.RestartCount}}'` and the app log before the boot line.
- [ ] **Watch errors, failed jobs and slow requests too.** Set `ELARA_MONITORING_TOKEN` (`openssl rand -hex 32`) and give the same value to the monitor: it then also alerts on new 5xx responses, failed background jobs (embeddings, extraction, repository sync, live edits that could not be saved to the note file, scheduled backups) and slow endpoints, optionally through `ALERT_WEBHOOK_URL`. No note text is ever part of these reports. See [monitoring.md](monitoring.md).

---

## 6. Git repository freshness

A git repository stays current through its webhook (`POST /repositories/<id>/webhook`, signed with the secret set on the repository) and a polling fallback that never switches off.

- [ ] **`POLL_INTERVAL_MS`** (default `300000`, 5 min): how often the server checks git repositories. An unchanged remote costs one `git ls-remote`, not a fetch.
- [ ] **`WEBHOOK_STALE_THRESHOLD_MS`** (default `600000`, 10 min): a repository whose webhook delivered within this window is left to the webhook. Once no delivery has arrived for longer (the hook was deleted, disabled or cannot reach your host), or when the last sync failed, the repository is polled on every interval again. So a broken hook delays updates by at most the threshold plus one poll interval; keep the threshold at least twice the poll interval so a working hook is not polled needlessly.
- [ ] **A quiet webhook is not an error**: a repository nobody pushes to gets no deliveries, so it falls back to polling after the threshold. `lastWebhookAt` (MCP `list_repositories`, REST repository list) shows when the last signed delivery arrived; `syncStatus`/`lastSyncError` show whether the last sync worked.
- [ ] **Disk for git mirrors** (#684): each git repository keeps a bare, shallow mirror at `DATA_DIR/git-mirrors/<repository id>.git`, and a sync fetches only what changed into it (a one-file commit is a few hundred bytes, not a new clone). Budget about the packed size of each repository's tip tree, plus up to four fetches' worth of replaced objects before git folds them (the `rea` benchmark repository: 11 MB for 3,764 files). Deleting a repository removes its mirror; mirrors of repositories deleted while the server was down go at the next start. Mirrors are a cache: you can leave `git-mirrors/` out of volume backups or delete it while the server is stopped, and the next sync of each repository fetches its tip once (the cost of one shallow clone) and re-reads its files without re-indexing unchanged ones. The first sync after upgrading to this release does the same.

---

## 7. Note size limit

- [ ] **`ELARA_NOTE_MAX_BYTES`** (default `1048576`, 1 MiB): the largest note body, in UTF-8 bytes, that any write path stores: the editor, REST, MCP and vault import. A change over it is refused (REST `413`, an MCP tool error naming the limit, the editor says the note is too large and keeps the text until it is shortened; import lists the note as skipped). In the editor the same limit also bounds the note's properties (frontmatter, measured as JSON) and anything else a client puts in the live document, separately from the body. A note already over the limit (stored before it, or under a larger one) can still be shortened. Restoring a full-instance backup keeps every note whatever its size. Any value that is not a positive whole number is ignored with a warning at start.
  REST, MCP and import bound a note's frontmatter (properties, measured as JSON keys and values) by the same limit, counted apart from the body, with the same rule: refused when it would end up over the limit and larger than before.
- [ ] **Reverse proxy body size**: request bodies and live-edit frames that carry a note may be up to 6 × the limit + 64 KiB (JSON escaping, up to 6 bytes per character, and frontmatter ride along). nginx refuses request bodies over 1 MB by default, below a note at the default limit: set `client_max_body_size 7m;` (or 6 × your limit + 64 KiB, rounded up).
