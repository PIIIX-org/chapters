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
| `.github/workflows/elara-lab.yml` | the workflow: `plan` picks the tier, `lab` builds, bootstraps, runs, gates, uploads |
| `lab/docker-compose.lab.yml` | compose override: mailpit for signup mail, `MCP_RATE_LIMIT`, local backups |
| `lab/bootstrap.ts` | setup → signup → verify → approve → login, pinned vault + repo, 4 MCP tokens; writes `lab-env.json` (runner only, holds tokens) |
| `lab/run.ts` | selects tests by tier or filter, runs them in file-name order, writes `lab-results/` |
| `lab/lib/*.ts` | helpers: `context` (types, `ctx`), `mcp`, `rest`, `docker` (compose, psql, app restart/crash/state/exec), `collab` (Hocuspocus client), `datapath` (disk/DB/.crdt ground truth, memory and health samplers), `fixlab` (repo progress, local_path repos), `portability` (zip, fixtures, OKF), `bundle-test` |
| `lab/tests/*.test.ts` | the tests |
| `lab/known-defects.json` | the baseline: every check that fails today, with its open issue |
| `.github/scripts/lab-gate.mjs` | the gate; unit tests in `lab-gate.test.mjs` (run by `checks`) |
| `lab/package.json`, `lab/bun.lock` | lab-only dependencies (`@hocuspocus/provider`, `yjs`, `playwright`); not a pnpm workspace package |

## Tiers and triggers

| tier | when | tests | time |
|---|---|---|---|
| fast | PRs to `dev` that change `server/**`, `lab/**`, `docker-compose.yml`, `Dockerfile`, the lab workflow or the gate; pushes to `lab/**` | tests with `tier: 'fast'`, with their long parts skipped | ~10 min |
| full | nightly 02:30 UTC on `dev`, every PR to `prod` (promotion), and by hand | every test, every part | over an hour |

The `plan` job reads the PR's changed files (GitHub API); a PR to `dev`
that touches none of those paths skips the `lab` job. Fast-tier tests
today: `smoke`, `concurrency`, `scoped-tokens`, `collab-duplication`
(without the eight-kill S17 sweep), `fix-attribution`,
`fix-crash-catchup`, `fix-frontmatter`, `fix-import-edges` (without the
chapters repo), `zz-fix-minified-bundle`. Full tier adds `attachments`,
`backup-restore`, `big-notes`, `browser` (Playwright/Chromium),
`crash-write`, `export-roundtrip`, `multilingual-search`,
`restart-extraction`, `zz-fix-pretty-bundle`.

By hand (any branch that has this workflow):

```sh
gh workflow run elara-lab.yml -R PIIIX-org/chapters --ref <branch>                      # full tier
gh workflow run elara-lab.yml -R PIIIX-org/chapters --ref <branch> -f tier=fast
gh workflow run elara-lab.yml -R PIIIX-org/chapters --ref <branch> -f tests=crash-write,smoke
gh workflow run elara-lab.yml -R PIIIX-org/chapters --ref <branch> -f mcp_rate_limit=120  # production limit
gh run download <id> -R PIIIX-org/chapters -n lab-results -D <dir>
```

`tests` is a comma-separated list of substrings of test file names and
overrides the tier's selection (the tier still decides whether a test runs
its long parts). A newer run on the same ref cancels the older one. The
lab job is **not a required check** yet (branch protection is fix-list
item 177); treat a red lab run on a PR as blocking review.

## The gate and the baseline

A test reports **checks**: `ok: true` (Elara met the expectation),
`ok: false` (Elara defect), `ok: null` (inconclusive: a precondition broke).
A test that **throws** or times out (`LAB_TEST_TIMEOUT_MS`, default 90 min)
is a harness crash. `lab/run.ts` only records; the gate step decides.

`lab/known-defects.json` lists every check that fails today:

```json
{
  "defects": [
    { "test": "fix-attribution", "check": "sequential edit_note credited to the MCP connection", "issue": 403 },
    { "test": "crash-write", "match": "^kill \\S+: check-notes clean$", "issue": 486,
      "intermittent": "depends on where the SIGKILL lands relative to the writes" }
  ]
}
```

- `check` is the exact check name; `match` a regex for a family of checks
  (exactly one of the two).
- `issue` is the open GitHub issue that tracks the defect.
- `intermittent` (optional, a reason) marks a check whose outcome depends
  on timing, so it may pass without being fixed.

The job fails when:

1. a test crashed, timed out or wrote no result, or the runner never
   started (build or bootstrap failed);
2. **regression**: a check failed that no entry covers;
3. **stale baseline**: an entry's checks all passed (unless
   `intermittent`), or, in the full tier, its test ran and no longer reports
   a check with that name (renamed or removed). The fast tier skips some
   checks, so a missing check is not stale there;
4. an entry points at a closed issue or at a PR;
5. the baseline file is malformed.

Inconclusive checks never fail the job. The gate writes its verdict to the
job summary and to `lab-results/gate.md`: regressions, stale entries, known
defects still failing (with issue links), intermittent ones that passed,
inconclusive checks. On a PR the workflow runs the **base** commit's copy of
the gate, like `pr-evidence` and `fails-before`; the baseline always comes
from the PR.

What to do when it is red:

- **Regression**: fix the code. If it is a real defect you are not fixing
  in this PR, open an issue and add an entry (that is a decision for the
  reviewer to see in the diff).
- **Stale entry** (your fix made a check pass): delete the entry in the same
  PR, and close the issue with the fix (`Closes #N`) or comment the lab run
  on it if the issue covers more than this check.
- **Harness crash**: read the error in the summary and the test's JSON; the
  instance logs are in `compose.log` of the artifact.

Regenerating the baseline after a deliberate change: dispatch the full
tier, download `lab-results`, and add or remove entries from the failed
checks of each `<test>.json` (`checks[] | select(.ok == false) | .name`),
each with the issue it belongs to. Prefer exact `check` names; use `match`
only for a family that fails together (kill rounds, per-N scenarios).

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
  never in `name`.
- Fast tier only if the test runs in about a minute; put long parts behind
  `ctx.tier === 'full'`.
- Tests run sequentially in file-name order on **one** instance. Create
  your own vaults, repos and tokens (`ctx.uniq`); do not delete or break the
  bootstrap resources. A test that restarts or kills the app must leave it
  healthy (`ctx.docker.app.restart/crash` wait for `/health`). Tests that
  can take the instance down are named `zz-` so they run last.
- Never print secrets: credentials and tokens come from `ctx.env`; redact
  them from error text you throw (see `browser.test.ts`). The workflow
  generates `.env` per run and masks it; `lab-env.json` is never uploaded.
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
| `ctx.mintToken(user, name, scope?, ids?)` | new MCP connection via `POST /api/mcp-connections` → `{id, token}` |
| `ctx.createVault(user, name)` / `ctx.connectRepo(user, name, gitUrl)` | REST create; repo sync starts immediately (public https URLs only) |
| `ctx.docker.app.restart(baseUrl)` / `.crash(baseUrl)` | graceful restart / `docker kill -s KILL` + start, both wait for `/health` |
| `ctx.docker.app.state()` / `.logs(service, n)` / `.stop()` / `.start()` | `docker inspect` (restart count, OOM, start time), log tail, raw control |
| `ctx.docker.appExec(args, stdin?)` | a command inside the app container |
| `ctx.docker.psql(sql)` / `ctx.docker.psqlRows<T>(select)` | SQL in the `db` container: ground truth MCP does not show |
| `ctx.log(...)`, `ctx.uniq(prefix)` | timestamped log line; unique slug-safe name |

Tunables via env (set in the workflow step if needed): `LAB_TESTS`,
`LAB_TIER`, `LAB_TEST_TIMEOUT_MS`, `LAB_CONCURRENCY_SIZES` (`5,10,20`),
`LAB_RESTART_REPO_URL`, `LAB_RESTART_AT` (0.25), `LAB_RESTART_STALL_MS`
(120000), `LAB_SCOPE_OTHER_REPO_URL`, `LAB_SCOPE_PINNED_REPO_URL`,
`LAB_IMPORTS_REPO_URL`, `LAB_CRASH_EDITS`, `LAB_CRASH_CREATES`,
`LAB_BIG_SIZES_KIB`, `LAB_BUNDLE_*`.

## Gotchas

- Notes: `type` in frontmatter must equal the first path segment; segments
  `^[a-z0-9][a-z0-9-]*$`; `edit_note` frontmatter replaces the whole map.
- `note_history` returns every revision with its full body (#411): fine on
  lab notes, never on big ones.
- The image runs `NODE_ENV=production`: session cookies are `Secure`;
  `RestSession` carries them by hand over http.
- `EMBEDDINGS=local`: the first embedding downloads the ONNX model (~130 MB)
  inside the container; the first search or extraction is slower.
- The runner has 4 vCPU and 16 GB; `big-notes` deliberately drives the app
  into a V8 heap OOM (#411) and waits for Docker to restart it.
- No secrets of its own: the workflow generates `.env` per run
  (`CREDENTIALS_ENCRYPTION_KEY`, `SETUP_TOKEN`, `POSTGRES_PASSWORD`) and
  masks it; `MCP_RATE_LIMIT` is 600 unless dispatched otherwise.
