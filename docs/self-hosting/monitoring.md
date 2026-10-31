# Monitoring errors, failed jobs and slow requests

`GET /health` tells you the app is up and whether it restarted ([checklist](checklist.md), section 5). It does not tell you that requests are failing, that a background job (embeddings, code extraction, repository sync, saving a live edit to the note file, a scheduled backup) failed, or that an endpoint got slow. Elara keeps those numbers in memory and serves them on an authenticated endpoint, and the uptime monitor script turns them into alerts.

## What the server records

Every finished request is counted per **route template** (`PUT /api/vaults/:id/notes/*`, never the URL itself: no note path, no query string). Every 5xx response and every failed background job becomes an **error report**:

| field | request (5xx) | job failure |
|---|---|---|
| `seq`, `at` | number since the process started, time | same |
| `route`, `status`, `durationMs` | route template, HTTP status, time taken | |
| `reqId` | Fastify's request id: find the full error in the log with it | |
| `actor` | `user` (session), `token` (bearer token), `anonymous` | |
| `job`, `subjectId` | | `embedding`, `extraction`, `sync`, `collab-store`, `backup`, `projection` or `compaction`; the note, file, repository or vault id |
| `error` | `{name, code}`: the error's class and code (`Error`, `EACCES`, `PostgresError 23505`) | same |

**No error message, no note text, no path, no query string, no credential** is ever part of a report: an error message can quote a note's text, its path (its title) or a URL with a token in it, so it is left out entirely rather than filtered. The full error still goes to the app's log (`docker compose logs app`) as before, on your own host; each report also adds one JSON line there, `{"event":"server_error",...}` or `{"event":"job_failure",...}`, with exactly the fields above.

What counts as a failed job:

- `embedding`: a note's embedding failed 3 attempts in a row (retried after 1 and 2 minutes, and once more at the next restart, also when an earlier version of the note has an embedding; the earlier failures only add to `repeated`; a note whose embedding stopped the process 3 times is reported with error name `LeaseExpired` and is retried only after an upgrade that changes the embedder; search will not find it by meaning), or the embedding worker thread died (no `subjectId`; error name `EmbeddingWorkerCrash`; the next batch starts a new worker, and the note or file it was embedding fails or retries as usual, so one crash is counted twice: once here and once as that note's `embedding` failure or that file's `extraction` failure);
- `extraction`: a repository file's code extraction or embedding failed 3 attempts (retried after 1 and 2 minutes; the earlier failures only add to `repeated`). `repository_status` lists such files with the error as `extractionFailures`. The next restart retries them once more (the file's current content, also when an earlier version has an embedding). A file whose extraction stopped the process 3 times is reported with error name `LeaseExpired` and is not retried at restart, only once more after an upgrade that changes the extractor or the embedder. Until a file's new extraction succeeds, its previous symbols, imports and embedding stay searchable. After an upgrade that changes the extractor, the first start re-extracts every file in the background, keeping the vectors whose text is unchanged (about 24 ms a file); after one that changes the embedder, it also re-embeds every file and note. New notes and pushes go first. Watch `filesPendingExtraction` (see `docs/self-hosting/backup.md` §5, migration 0033);
- `sync`: a git or local-folder repository sync failed (also shown on the repository card). Counted once, when the repository goes into `error`: the poller retries a failing git repository every `POLL_INTERVAL_MS`, and a user or agent may retry it by hand; each retry that fails again only adds to `repeated`, not to `failed` (no new report, no log line, no alert). Two syncs that overlap (a poll and a webhook delivery) and both fail count one failure at most. A new error on a repository already in `error` (say, an expired credential, then a deleted remote) is only on its card;
- `collab-store`: a live (collaborative) edit could not be saved to the note, for example because its frontmatter was invalid, or the fold of a note's saved live edits failed at startup (the note gets a `fold_error`; startup goes on). **The note keeps its last valid version while the editors keep seeing their edit**, and the edit itself is kept in the database: look at it;
- `backup`: a scheduled backup failed (an on-demand one that fails is a 500 instead). A scheduled backup that fails after the previous backup (scheduled or on demand) also failed only adds to `repeated`, so `ELARA_BACKUP_INTERVAL_HOURS=1` with a broken destination is one alert, not one an hour. Any backup that succeeds, including "run backup now" after a fix, ends that: the next scheduled failure alerts again (the state restarts with the process);
- `projection`: a note's `.md` file or a folder's `index.md` could not be written (a read-only or full disk). The database holds the note, so the write that caused it **succeeded** (no 500): reads, search and agents are unaffected, and the file is written once the disk accepts it (retried with a backoff; the retries only add to `repeated`). `pnpm check-notes` lists files still pending.
- `compaction`: the compaction of a note's long revision history (see [backup.md](backup.md), revision history) failed 3 attempts (retried after 1 and 2 minutes; the earlier failures only add to `repeated`). **Nothing is lost:** every revision stays readable exactly as it was, and the history just takes more space until the note's next 25 writes or the next restart queue it again.

A file the server did not write found where it writes (a hand edit, or an unparseable `.md` the store migration rewrites from its row) is copied to `.conflicts/` first (ADR-003). That is intended behaviour, **not a job failure**: it is counted in `conflictCopies` on the endpoint (`copies`, and `paths`, the number of distinct note paths copied since the process started; never the path itself), adds no error report or log line, and raises no `jobs` alert. The server log has one `[projector] ... copied to .conflicts/...` warning per copy with the path.

`repeated` per job kind is on the endpoint and in the jobs alert's "since the process started" line.

Metrics are per process and in memory: per route, request count, 5xx count, and p50/p95/p99 and max latency over the **last 15 minutes**; totals since the process started; the last 50 error reports. A restart resets them (the restart itself is what `/health` reports). Percentiles are the upper bound of a latency bucket (…, 1000, 1500, 2000, 2500, 3000, … ms), capped at the slowest request seen, so they can read up to one bucket high.

## The endpoint

`GET /api/admin/monitoring` answers either

- an **admin session** (signed in as an admin in the browser), or
- `Authorization: Bearer <ELARA_MONITORING_TOKEN>`, the value of the `ELARA_MONITORING_TOKEN` environment variable (at least 32 characters; a shorter one is ignored with a warning at start). Generate it with `openssl rand -hex 32` and put it in `.env`; `docker-compose.yml` passes it through.

Anyone else gets `401` (or `403` for a signed-in non-admin). `/health` does not change: it shows nothing of this.

```json
{
  "bootId": "0199ec5a-8a2e-7c41-9d3b-5f0e2a7c1b44",
  "startedAt": "2026-10-19T09:12:03.118Z",
  "now": "2026-10-19T12:40:00.000Z",
  "windowMinutes": 15,
  "totals": { "requests": 18234, "serverErrors": 2, "jobFailures": 1 },
  "jobs": { "embedding": { "succeeded": 410, "failed": 0, "repeated": 0 }, "extraction": { "succeeded": 0, "failed": 0, "repeated": 0 }, "sync": { "succeeded": 12, "failed": 1, "repeated": 30 }, "collab-store": { "succeeded": 88, "failed": 0, "repeated": 0 }, "backup": { "succeeded": 1, "failed": 0, "repeated": 0 }, "projection": { "succeeded": 95, "failed": 0, "repeated": 0 } },
  "conflictCopies": { "copies": 13, "paths": 13 },
  "routes": [{ "route": "POST /mcp", "count": 312, "serverErrors": 0, "p50Ms": 25, "p95Ms": 150, "p99Ms": 400, "maxMs": 612 }],
  "errors": [{ "seq": 3, "at": "2026-10-19T12:31:07.004Z", "type": "job", "job": "sync", "subjectId": "0199…", "error": { "name": "Error", "code": null } }],
  "lastSeq": 3
}
```

### Prometheus: `GET /api/admin/metrics`

The same store in the Prometheus text format, under the same access rule (token or admin session), for a scraper. Beyond the totals above it carries what `/api/admin/monitoring` does not: process RSS and heap, event-loop lag (p50/p99/max over the last 15 s), the pending background jobs per kind with the age of the oldest, and duration histograms of each search leg and of each file extraction stage (extract, embed, write). Every metric, its labels and the alert it is meant for are listed in `docs/agents/backend-reference.md` (§8, Error reports and metrics). A scrape job:

```yaml
scrape_configs:
  - job_name: elara
    metrics_path: /api/admin/metrics
    authorization: { credentials: '<ELARA_MONITORING_TOKEN>' }
    static_configs: [{ targets: ['elara.example.com:443'] }]
    scheme: https
```

## Alerts

[`.github/scripts/uptime-monitor.mjs`](../../.github/scripts/uptime-monitor.mjs) (plain Node 24, no dependencies) reads `/health` and, when `ELARA_MONITORING_TOKEN` is set in its environment and `/health` is up, the endpoint above. It alerts on:

| alert | when | setting (environment) |
|---|---|---|
| **errors** | at least N new 5xx responses since the last check | `ALERT_ERROR_THRESHOLD`, default `1` |
| **jobs** | any new failed background job | |
| **slow** | a route newly has p95 ≥ M ms over at least K requests in the last 15 minutes (once, until it is fast again) | `ALERT_SLOW_MS`, default `2000`; `ALERT_SLOW_MIN_COUNT`, default `5` |
| **metrics unavailable** | `/health` is up but the endpoint failed 2 reads in a row (wrong or rotated token); once per streak | |

plus the restart, down, recovered and weekly check-in alerts of the uptime monitor. The server's counters are cumulative, so a check that runs late misses nothing; after a restart everything since the restart counts as new. The threshold is per check: with `ALERT_ERROR_THRESHOLD=5` and checks every 10 minutes, 5 errors within one interval alert, 1 per interval never does.

**errors** and **jobs** alert once per streak, not on every check: while new ones keep coming (one endpoint that keeps failing, a job that fails on every edit), the next alert is for a route or job kind the streak has not had yet, or 24 hours after the last one, with the number held back in between. New routes alert at most once an hour, listed together (a broken dependency can fail many routes in turn); a new job kind alerts at once. A streak ends after an hour without a new one; if something was held back, or new routes were not commented yet, a short "stopped" alert says how many and names them. So a second subject failing the same job kind during a streak (a second repository going into `error` while the first still fails) is held: it shows only in that "stopped" count or the 24-hour alert, not as its own alert; the endpoint and the `job_failure` log lines have it. A streak remembers up to 320 routes (more than the server ever reports); past that, unknown routes are held too.

Run it from cron on any machine that can reach your instance (not the same host: it should notice when the host is down):

```bash
# every 10 minutes
ELARA_MONITORING_TOKEN=... ALERT_WEBHOOK_URL=https://hooks.slack.com/services/... \
  node uptime-monitor.mjs --url https://elara.example.org --state-file /var/lib/elara-monitor/state.json
```

- `--state-file` keeps what it saw last (so each event alerts once) and posts nothing to GitHub.
- `ALERT_WEBHOOK_URL` (optional): every alert is POSTed there as JSON, `{ "text": "<markdown>", "content": "<the same, at most 2000 characters>", "url": "...", "alerts": [...] }`; `text` suits Slack and most chat webhooks, `content` Discord. A failed POST makes the run exit non-zero without saving the state, so the next run tries again. With `--state-file` the webhook is the only place alerts go, so a value that is not an http(s) URL stops the run.
- Each run prints one JSON line (what it saw, the alerts and the message). Without `ELARA_MONITORING_TOKEN` it only checks `/health`, and still exits 0.

Alerts carry route templates, statuses, error classes and codes, request ids and job kinds, not the subject ids (they may end up in a public place, like the Elara project's own alert issue). To see which note, file or repository a failed job was about, read the endpoint with an admin session or grep the log for `job_failure`.

The Elara project runs the same script from a scheduled GitHub Actions workflow ([`.github/workflows/uptime.yml`](../../.github/workflows/uptime.yml)) that comments on an issue; see `docs/agents/github-workflow.md` (Production uptime monitor).
