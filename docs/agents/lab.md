# Elara lab: integration tests in CI

The lab tests the places where components meet: the collab relay, the note
store, files on disk, Postgres and MCP over HTTP. Unit suites cannot see
these (#576). Each run builds Elara **from the commit under test** with the
repo's own `docker-compose.yml`, bootstraps it through the real
setup / signup / mail / approval flow, runs `lab/tests/*.test.ts` on the
runner host against that instance, and judges the results against a
committed baseline of known defects.

| file | what |
|---|---|
| `.github/workflows/elara-lab.yml` | the workflow: `plan` picks the lab tier and the benchmark tier, `lab` builds, bootstraps, runs, gates, uploads; `bench` runs the premise benchmark on its own instance |
| `.github/workflows/agent-trial.yml` | the agent trial (#571): real AI agents on the 8 A/B tasks against a lab instance, weekly and by hand; skips without an agent credential (see below) |
| `.github/actions/lab-instance/action.yml` | shared by `lab`, `bench` and the agent trial's `trial` job: per-run secrets and `ELARA_VERSION` (the commit, baked into the image like `publish.yml` does) in `.env`, `docker compose up -d --build`, `bun lab/bootstrap.ts` |
| `lab/docker-compose.lab.yml` | compose override: mailpit for signup mail, `MCP_RATE_LIMIT`, local backups, the `ELARA_VERSION` build arg |
| `lab/bootstrap.ts` | setup → signup → verify → approve → login, pinned vault + repo, 4 MCP tokens; writes `lab-env.json` (runner only, holds tokens) |
| `lab/run.ts` | selects tests by tier or filter, waits for `/health` before each, runs them in file-name order, writes `lab-results/` |
| `lab/redact.ts` | replaces this run's secrets (`.env` values, bootstrap passwords, cookies, tokens) with `***` in `lab-results/` before upload |
| `lab/lib/*.ts` | helpers: `context` (types, `ctx`), `mcp`, `rest`, `docker` (compose, psql, app restart/crash/state/exec), `app-recovery` (bringing the app back after a SIGKILL), `collab` (Hocuspocus client), `datapath` (disk/DB/.crdt ground truth, memory and health samplers), `fixlab` (repo progress, local_path repos), `file-diff` (file-count comparison text), `git-fixture` (a pinned git repository served to the app over HTTP), `portability` (zip, fixtures, OKF), `bundle-test`; `lab/lib/*.test.ts` are node unit tests of the helpers that need no instance, run by CI `checks` |
| `lab/tests/*.test.ts` | the tests |
| `lab/known-defects.json` | the baseline: every check that fails or is inconclusive today, with its open issue |
| `.github/scripts/lab-gate.mjs` | the gate; unit tests in `lab-gate.test.mjs` (run by `checks`) |
| `.github/scripts/lab-nightly-alert.mjs` | the `nightly-alert` job: opens, updates or closes the `lab-nightly` issue after the scheduled run (#706); unit tests in `lab-nightly-alert.test.mjs` (run by `checks`) |
| `lab/package.json`, `lab/bun.lock` | lab-only dependencies (`@hocuspocus/provider`, `yjs`, `playwright`); not a pnpm workspace package |

## Tiers and triggers

| tier | when | tests | time |
|---|---|---|---|
| fast | PRs to `dev` that change anything the image is built from (`server/**`, `client/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `Dockerfile`, `.dockerignore`, `docker-compose.yml`) or the lab (`lab/**`, the lab workflow, the `lab-instance` action, the gate); pushes to `lab/**` | tests with `tier: 'fast'`, with their long parts skipped | lab job 5 min 37 s (run 38830575391) |
| full | nightly 02:30 UTC on `dev`, every PR to `prod` (promotion), and by hand | every test, every part | lab job 61 min (run 38830570057; `restart-extraction` 19 min, `big-notes` 18 min) |

The `plan` job reads the PR's changed files (GitHub API); a PR to `dev`
that touches none of those paths skips the `lab` job. Lockfile-only
changes (Dependabot bumps of `yjs` or `@hocuspocus/*`, for example) run the
fast tier. Fast-tier tests today: `access-behaviour` (token revocation,
deactivation and hashing, the MCP rate limit and its 429, two-account
separation, note text in prompts; #552), `smoke`, `concurrency`,
`scoped-tokens`, `collab-duplication` (without the eight-kill S17 sweep),
`fix-attribution`, `fix-crash-catchup`, `fix-frontmatter`,
`fix-import-edges` (without the chapters repo), `monitoring-alerts`
(the uptime monitor with the lab's `ELARA_MONITORING_TOKEN` and
`ALERT_WEBHOOK_URL` on a stub sink: an attachment upload into a read-only
`assets` directory (500) produces an `errors` alert, and a note file the
server cannot write (the PUT still answers 200, ADR-003) and a failing git
sync each produce a `jobs` alert, with no note text or secret in them; #705),
`uptime-monitor` (`.github/scripts/uptime-monitor.mjs` against the
instance through a graceful restart, a SIGKILL, a stop and a start; #583),
`zz-fix-minified-bundle`.
Full tier adds `attachments`, `backup-restore`, `big-notes`, `browser`
(Playwright/Chromium), `crash-write`, `export-roundtrip`,
`multilingual-search`, `restart-extraction`, `store-failpoints`,
`store-migration`, `store-rollback`, `zz-fix-pretty-bundle`.

The ADR-003 store tests (`lab/lib/store.ts` helpers):

- `store-failpoints`: for each S2a boundary in `server/src/failpoints.ts`
  the app is recreated with `ELARA_FAILPOINTS=<name>` (passed through by
  `lab/docker-compose.lab.yml`; inert when unset), the operation that
  reaches it runs, the process SIGKILLs itself there, the app is
  recreated inert, and I1 (the write is in the row exactly when it
  committed), I2 (a revision at every `seq`), I4 (`check-notes
  --wait-idle --fail-on-pending`), I5 (no `*.tmp`) and the operation's
  own effect are checked.
- `store-migration`: builds the image from before S2a
  (`LAB_PRE_S2A_REF`, default the `dev` commit #828 was based on; `git
  fetch` + `docker build`, cached per runner as `elara-lab-pre-s2a`),
  runs it with the store bookkeeping reset, makes every damage class
  (SIGKILL in old-code writes, unparseable file, hand edit, hand-formatted
  file, row changed by SQL, orphan temp file), then boots the image under
  test and checks the backfill report and the invariants; a second run
  with a kill at `migration.mid-batch` must end in the same state.
- `store-rollback`: `store-export-legacy` refused next to a running app,
  run with the app stopped, the old image's edits (agent, collab, rename,
  delete + restore), graceful stop, roll forward: I2, I4 and no new
  `.conflicts/` entry.

The image switch retags compose's `<project>-app` image and recreates the
container without a build; each test puts the image under test back
before it ends, so later tests run on it.

`browser` is the only test that drives the web client. A PR that changes
the client's collab code (`client/src/hooks/useCollabDoc*`,
`client/src/hooks/useCodeMirrorEditor*`, `client/src/api/collab*`) adds it
to the fast tier (`LAB_ALSO=browser`); any other client change is
exercised in the browser only by the nightly full tier.

A PR that changes backup or restore code (`server/src/export/**`,
`server/src/scripts/restore-backup.ts`, `server/src/notes/atomic-write.ts`,
`lab/tests/backup-restore.test.ts`) adds `backup-restore` the same way
(#493): a backup taken through the API, restored with `pnpm restore-backup`
into a fresh database, then its counts, `backup.json` digests, file modes
and content checked, and a tampered copy refused.

By hand (any branch that has this workflow):

```sh
gh workflow run elara-lab.yml -R PIIIX-org/chapters --ref <branch>                      # full tier
gh workflow run elara-lab.yml -R PIIIX-org/chapters --ref <branch> -f tier=fast
gh workflow run elara-lab.yml -R PIIIX-org/chapters --ref <branch> -f tests=crash-write,smoke
gh workflow run elara-lab.yml -R PIIIX-org/chapters --ref <branch> -f mcp_rate_limit=120  # production limit
gh workflow run elara-lab.yml -R PIIIX-org/chapters --ref <branch> -f tier=none -f bench=chapters  # benchmark only
gh run download <id> -R PIIIX-org/chapters -n lab-results -D <dir>
```

`tests` is a comma-separated list of substrings of test file names and
overrides the tier's selection (the tier still decides whether a test runs
its long parts). A newer run on the same ref cancels the older one; the
nightly has its own concurrency group, so a dispatch or PR on `dev` never
cancels it. `plan` and `lab` are **required status checks** on `dev` and
`prod` (#574; `lab` is skipped, which passes, when `plan` picks no tier).

### Nightly alert (`nightly-alert` job, #706)

After the scheduled run on `dev`, the `nightly-alert` job keeps one open
issue titled "Nightly lab failing", labelled `lab-nightly`, in step with
the nightly, so a red night notifies the issue's subscribers instead of
only turning STATE.md's generated block bold:

- **red** (a job failed or was cancelled, or `lab` did not run): with no
  open issue it opens one, else it comments on it; either way the text has
  the failed jobs, the run link and the gate summary (`lab-results/gate.md`
  without its known-defect tables: counts, harness failures, regressions,
  stale entries; plus `bench-gate/gate.md` when the benchmark failed);
- **green**: it comments with the run link and closes the open issue.

It posts only for the `schedule` event on `dev` of PIIIX-org/chapters; it
does not run on PRs or pushes. To see what it would post without posting:
`gh workflow run elara-lab.yml -R PIIIX-org/chapters --ref <branch> -f alert_dry_run=true [-f tier=fast]`
(the job summary shows the decision and the text). Fix the cause, or
update `lab/known-defects.json`, as for any red gate; the issue closes
itself on the next green nightly.

## The premise benchmark (`bench` and `bench-gate` jobs)

The `bench` jobs (#570) measure what Elara exists for: tokens and calls an
agent needs to reach the evidence for a question, Elara's MCP `search` +
`read_file` against ripgrep + ranged reads on a checkout of the same
commit. Three `bench` jobs (matrix `instance: [1, 2, 3]`) run next to the
`lab` job, each on its own runner and instance (same `lab-instance`
action); `bench-gate` then gates the per-metric median of the three,
because Elara's ranks move between identical instances (#623).

| tier | when | suites | time |
|---|---|---|---|
| chapters | PRs to `dev` touching `server/src/{search,mcp,repositories,db}/`, `server/src/{config,index,app}.ts`, `server/drizzle/`, `server/package.json`, `pnpm-lock.yaml`, `Dockerfile`, `docker-compose.yml`, `benchmarks/`, `lab/bootstrap.ts`, `lab/lib/`, `lab/docker-compose.lab.yml`, the workflow, the action or `bench-gate.mjs` | `chapters` (29 questions) | about 9 min (instances in parallel) |
| all | nightly, every PR to `prod`, by hand (`-f bench=all`) | all five suites (109 questions) | about 50 min (instances in parallel) |

Dispatches default to `bench=none`, so a hand-started lab run costs no
extra runner. `benchmarks/run.ts` reads `lab-env.json`, refuses any base
URL that is not the lab instance on the runner (never production), fetches
each suite's repository at its pinned commit, copies it into the app
container as a `local_path` repository (`lab/lib/fixlab.ts`), waits until
every file is embedded (one suite at a time: extraction is one global
queue), then runs both scripted agents on every question and writes
`bench-results/` (artifacts `bench-results-<n>`, 90 days). The gate
`.github/scripts/bench-gate.mjs` compares the median with
`benchmarks/baseline.json`; on a PR it runs the base commit's copy, judges
regressions against the base commit's baseline, and needs an owner label
for a changed suite or a lowered baseline. Method, metrics, thresholds,
overrides and how to regenerate the baseline: `benchmarks/README.md`.

## The agent trial (`agent-trial.yml`)

Real AI agents on the study's 8 A/B tasks (#571), Elara-only (MCP) against
local-only (read/grep on a checkout of the same commit), on a lab instance
built by the same `lab-instance` action. A separate workflow, not part of
`elara-lab.yml` and not a required check: weekly (Mondays 04:00 UTC) and by
hand.

| job | what |
|---|---|
| `gate` | `node benchmarks/agent-trial/gate.ts`, given only whether the key exists (`AGENT_TRIAL_HAS_KEY`) and `AGENT_TRIAL_MODEL`: with no agent credential it prints `skipped: no agent credential (#571)` and the run ends green; nothing is built |
| `trial` | lab instance, then `bun benchmarks/agent-trial/run.ts`: refuses a non-lab base URL, fetches PIIIX-org/chapters at the pinned commit, checks every evidence range of `tasks.json`, indexes the tree as a `local_path` repository, mints a repository-pinned read token allow-listed to the Elara arm's tools, runs each task in both arms, grades, writes `agent-trial-results/` after every episode (artifact, 90 days) |

The key is a secret of the `agent-trial` environment, whose deployment
branches are `dev` only; it must not be a repository secret. Only a run on
`dev` (the schedule, or a dispatch on dev) binds the environment, so a
dispatch on any other branch sees no key: there, only `model=scripted` runs.

```sh
gh workflow run agent-trial.yml -R PIIIX-org/chapters --ref dev                       # live; skips without a credential
gh workflow run agent-trial.yml -R PIIIX-org/chapters --ref <branch> -f model=scripted  # dry run, fake model
gh workflow run agent-trial.yml -R PIIIX-org/chapters --ref dev -f tasks=T1 -f arms=elara
```

The owner provides no model API key, so the scheduled run skips until one
is configured. A dry run tests the plumbing end to end and its numbers are
not agent numbers. Method, caps, grading, settings and how to read a run:
`benchmarks/README.md`, "Agent trial".

## The gate and the baseline

A test reports **checks**: `ok: true` (Elara met the expectation),
`ok: false` (Elara defect), `ok: null` (inconclusive: a precondition broke,
for example a token was refused or the instance did not answer). A test that
**throws**, times out (`LAB_TEST_TIMEOUT_MS`, default 90 min) or reports no
checks is a harness crash; so is a test whose instance is not healthy within
180 s before it starts. After a timeout, or after the first test that finds
the instance unhealthy, the remaining tests are not run (the timed-out test
may still be driving the instance; a dead instance would only crash each of
them after another 180 s wait, #658) and count as crashed.
`lab/run.ts` only records; the gate step decides.

`lab/known-defects.json` lists every check that does not pass today:

```json
{
  "defects": [
    { "test": "fix-attribution", "check": "sequential edit_note credited to the MCP connection", "issue": 403 },
    { "test": "crash-write", "match": "^kill \\S+: check-notes clean$", "issue": 486,
      "intermittent": "depends on where the SIGKILL lands relative to the writes" }
  ]
}
```

- `check` is the exact check name; `match` an anchored regex (`^...$`) for
  a family of checks that differ only in numbers (kill delay or round, N)
  (exactly one of the two).
- `state` is `failed` (default) or `inconclusive`: the state the check is in
  today. An entry only covers checks in its state.
- `issue` is the open GitHub issue that tracks the defect.
- `intermittent` (optional, a reason) marks a check whose outcome depends
  on timing, so it may pass without being fixed.

The job fails when:

1. a test crashed, timed out, wrote no result, reported no checks or found
   the instance unhealthy, or the runner never started (build or bootstrap
   failed);
2. **regression**: a check failed, or came out inconclusive, and no entry
   for that state covers it. Inconclusive is not a pass: if pinned tokens
   stopped working altogether, `scoped-tokens` would turn ~250 checks
   inconclusive, and that must be red;
3. **stale baseline**: an entry's checks are no longer in its state (unless
   `intermittent`), or, in an unfiltered full-tier run, its check or its
   whole test is no longer reported (renamed or removed). The fast tier
   skips some checks, so a missing check is not stale there;
4. **over-broad family**: a `match` entry covers checks of more than one
   kind in this run. The kind is the check name with every number (and a
   letter glued to it: `t100`, `S17`, `N=5`) replaced by `#`. So
   `^S17 SIGKILL \d+ ms after ack: .*$` is rejected as soon as it also
   covers the `disk = DB = .crdt = clients` checks, which pass; a family
   cannot hide a different check that shares its prefix;
5. an entry points at a closed issue or at a PR;
6. the baseline file is malformed (including an unanchored regex).

The gate writes its verdict to the job summary and to
`lab-results/gate.md`: regressions (with their state), stale entries,
over-broad families, known defects (with issue links), intermittent ones
that passed. On a PR the workflow runs the **base** commit's copy of the
gate, like `pr-evidence` and `fails-before`; the baseline, the tests and
`lab/run.ts` always come from the PR, so that protects the verdict logic
only.

What to do when it is red:

- **Regression**: fix the code. An inconclusive regression usually means a
  precondition broke (tokens refused, instance down, a fixture call failed):
  read `actual`. If it is a real defect you are not fixing in this PR, open
  an issue and add an entry (that is a decision for the reviewer to see in
  the diff).
- **Stale entry** (your fix made a check pass): delete the entry in the same
  PR, and close the issue with the fix (`Closes #N`) or comment the lab run
  on it if the issue covers more than this check.
- **Over-broad family**: narrow the regex to the failing kind, or split it.
- **Harness crash**: read the error in the summary and the test's JSON; the
  instance logs are in `compose.log` of the artifact.

Regenerating the baseline after a deliberate change: dispatch the full
tier, download `lab-results`, and add or remove entries from the checks of
each `<test>.json` that are not `ok: true` (`checks[] | select(.ok != true)`),
each with the issue it belongs to and `"state": "inconclusive"` for
`ok: null`. Prefer exact `check` names; use `match` only for a family that
differs in numbers (kill rounds, per-N scenarios). Then lint it against
the runs it came from (fast and full):

```sh
node .github/scripts/lab-gate.mjs --lint <full-run-dir>,<fast-run-dir>
```

The lint fails when an entry matches no check in those runs, or when an
entry (or one kind of check a family covers) was never in the entry's
state in any of them, which is how a family that also covers an
always-passing check shows up.

## Adding a test

Create `lab/tests/<name>.test.ts` (copy `smoke.test.ts`, the smallest):

```ts
import type { Check, LabTest } from '../lib/context.ts'

const test: LabTest = {
  name: 'my-test',
  tier: 'fast', // omit for full tier only
  description: 'one line',
  async run(ctx) {
    const checks: Check[] = []
    const acct = ctx.mcp('adminAccount')
    const vault = await ctx.createVault('admin', ctx.uniq('my-test'))
    const r = await acct.call('create_note', {
      vaultId: vault.id, path: 'concepts/x', frontmatter: { type: 'concepts' }, body: 'hi',
    })
    checks.push({ name: 'create works', expected: 'ok', actual: r.ok ? 'ok' : r.text, ok: r.ok, severity: 'high' })
    return { summary: 'what was measured + headline', checks, data: { anything: 'raw' } }
  },
}
export default test
```

Rules:

- **Check names are identities**: the baseline matches them exactly. Keep
  run-specific values (ids, random markers, counts, timings) in `actual`,
  never in `name`. Scenario parameters (`N=5`, `900 KiB x 300`) may be in
  the name; the baseline holds for the default tunables, so a dispatch with
  `LAB_CONCURRENCY_SIZES` or `LAB_BIG_SIZES_KIB` changed reports their
  checks as regressions or stale.
- An observation with no expectation is not a check: put it in `data`.
  `ok: null` means "could not judge" and is a failure unless baselined.
- Fast tier only if the test runs in about a minute; put long parts behind
  `ctx.tier === 'full'`.
- Tests run sequentially in file-name order on **one** instance. Create
  your own vaults, repos and tokens (`ctx.uniq`); do not delete or break the
  bootstrap resources. A test that restarts or kills the app must leave it
  healthy (`ctx.docker.app.restart/crash` wait for `/health`; `crash`
  throws when the app does not come back, so the test stops there). Tests that
  can take the instance down are named `zz-` so they run last.
- Never print secrets: credentials and tokens come from `ctx.env`; redact
  them from error text you throw (see `browser.test.ts`). The workflow
  generates `.env` per run and masks it in the job log; masking does not
  reach artifacts, so `lab/redact.ts` replaces every generated secret (the
  app prints its setup token into `compose.log`) and the bootstrap
  passwords, cookies and tokens in `lab-results/` before upload.
  `lab-env.json` itself is never uploaded.
- A new failing check needs a baseline entry and an open issue in the same
  PR, or the gate fails.

Type-check and lint locally without a pnpm install: `eslint` covers `lab/`
in `pnpm lint`; for types run `tsc --noEmit` with `types: ["bun"]`,
`moduleResolution: "bundler"`, `allowImportingTsExtensions` over
`lab/**/*.ts` after `bun install` in `lab/`.

### What `ctx` gives you (`lab/lib/context.ts`)

| helper | what |
|---|---|
| `ctx.env` | `lab-env.json`: `baseUrl` (`http://localhost:3000`), `mailpitUrl`, `users.{admin,member}` (id, email, password, session cookie), `tokens.{adminAccount, memberAccount, adminVaultPinned, adminRepoPinned}`, `pinnedVaultId`, `pinnedRepositoryId` |
| `ctx.tier` | `'fast'` or `'full'` |
| `ctx.mcp(key \| rawToken, label?)` | `McpClient`: `call(tool, args)` → `{ok, isError, httpStatus, text, json, ms, retries429}` (never throws; HTTP 0 = server down), `must(tool, args)` (throws), `listTools()`, `rpc(method, params)`. Retries 429 with backoff; `run.ts` writes per-test call stats |
| `ctx.rest('admin' \| 'member')` | `RestSession` with the bootstrap cookie: `get`, `post`, `request`, `must`; `RestSession.login(baseUrl, email, password)` for a fresh session (login is limited to 10/min per IP) |
| `ctx.mintToken(user, name, scope?, options?)` | new MCP connection via `POST /api/mcp-connections` → `{id, token}`; `options`: `vaultId`/`repositoryId` for the pin, `access` (`read`/`write`/`admin`), `allowedTools`, `expiresAt` |
| `ctx.createVault(user, name)` / `ctx.connectRepo(user, name, gitUrl)` | REST create; repo sync starts immediately (public https URLs only) |
| `ctx.signupUser(email, password)` | a new active user through signup, the mailpit code, verification, admin approval and login → `{id, session}`; for tests that must deactivate or otherwise spend a user (never the bootstrap ones) |
| `ctx.docker.app.restart(baseUrl)` / `.crash(baseUrl)` | graceful restart / `docker kill -s KILL`, then (`lib/app-recovery.ts`, #658) wait for the old process to exit, `compose start` up to 3 times (a failed start, or a container that exits again during boot, is retried), wait up to 300 s for `/health`; throws with every attempt and the last app log lines when the app does not come back |
| `ctx.docker.app.state()` / `.logs(service, n)` / `.stop()` / `.start()` | `docker inspect` (restart count, OOM, start time), log tail, raw control |
| `ctx.docker.appExec(args, stdin?)` | a command inside the app container |
| `ctx.docker.psql(sql)` / `ctx.docker.psqlRows<T>(select)` | SQL in the `db` container: ground truth MCP does not show |
| `ctx.log(...)`, `ctx.uniq(prefix)` | timestamped log line; unique slug-safe name |

Tunables via env (set in the workflow step if needed): `LAB_TESTS`,
`LAB_TIER`, `LAB_ALSO`, `LAB_TEST_TIMEOUT_MS`, `LAB_CONCURRENCY_SIZES`
(`5,10,20`), `LAB_RESTART_REPO_URL` (default: none, see below), `LAB_RESTART_AT` (0.25),
`LAB_RESTART_STALL_MS` (120000), `LAB_SCOPE_OTHER_REPO_URL`,
`LAB_SCOPE_PINNED_REPO_URL`, `LAB_IMPORTS_REPO_URL`, `LAB_CRASH_EDITS`,
`LAB_CRASH_CREATES`, `LAB_BIG_SIZES_KIB`, `LAB_BUNDLE_*`.

`restart-extraction` compares several syncs of one repository over about
20 minutes, so that repository must not move during the run (#767: a merge
to `dev` mid-run read as lost files). By default it builds a one-commit
git repository from the tracked tree of the commit under test (`git
archive HEAD` of the workflow's checkout), serves it from the runner with
`git http-backend` (`lib/git-fixture.ts`) and connects it as
`http://host.docker.internal:<port>/chapters.git`; the lab compose
override maps `host.docker.internal` to the host gateway. Its file counts
therefore follow the commit under test. `LAB_RESTART_REPO_URL` replaces it
with a public URL, which may move again.

## Gotchas

- Notes: `type` in frontmatter must equal the first path segment; segments
  `^[a-z0-9][a-z0-9-]*$`; `edit_note` frontmatter merges per key
  (`replace: true` replaces the whole map, `removeKeys` deletes keys; #438).
- `note_history` returns one page of metadata, no bodies (#411): read the
  content with `get_revision`. `McpClient.revisionsSince()` (`lib/mcp.ts`)
  does both for tests that check what a revision holds.
- The image runs `NODE_ENV=production`: session cookies are `Secure`;
  `RestSession` carries them by hand over http.
- `EMBEDDINGS=local`: the first embedding downloads the ONNX model (~130 MB)
  inside the container; the first search or extraction is slower.
- No secrets of its own: the workflow generates `.env` per run
  (`CREDENTIALS_ENCRYPTION_KEY`, `SETUP_TOKEN`, `POSTGRES_PASSWORD`), masks
  it in the job log and redacts it from the artifact; `MCP_RATE_LIMIT` is
  600 unless dispatched otherwise.
