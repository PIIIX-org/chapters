# Chapters — GitHub Workflow

Two long-lived branches, everything else is short-lived.

## Branches

- **`dev`** (default) — integration branch. All work lands here via PR.
- **`prod`** — stable branch. Only ever receives promotions from `dev`.
  What's on `prod` is verified, working software.
- Feature branches: `<type>/<short-topic>` off `dev` — types: `feat`,
  `fix`, `docs`, `chore`, `test`. Deleted after merge.
- Never commit directly to `dev` or `prod`. No exceptions, including docs.

## The change cycle

Every change — code, spec, doc — follows the same loop:

1. **Branch** off `dev`.
2. **Commit + push** (early and often, per the resume protocol in
   `handling-protocols.md`).
3. **Open a PR** targeting `dev`. Fill in the template
   (`.github/pull_request_template.md`): Problem, Change, **Evidence**,
   Not covered, `Closes #N`. Evidence is links, not adjectives: the CI
   run, the fails-before run (or its justification), the lab run for
   integration changes, the benchmark delta for retrieval or token
   changes (the `bench-gate` job's summary; see **Premise benchmark** under
   CI). `gh pr create --body`, `--body-file` and `--fill` never load
   the template: copy it to a file under the workspace, fill it in, and
   pass that file with `--body-file`. The `pr-evidence` check (see
   **PR evidence** under CI below, which lists the rules) fails a body
   whose Evidence section is missing, links nothing or keeps template
   placeholders, and a claim (test counts, "verified", "100%", ...) with
   no link next to it. A fix PR (title
   `fix: ...` / `fix(scope): ...`, or with `!` before the colon) carries
   a regression test that fails without the fix; the `fails-before` check
   (see CI below) proves it on every push. Coverage depends on that title:
   a fix PR titled otherwise is skipped. If no such test can exist (docs-
   or CI-only fix), add the label `no-fails-before` and a line
   `Fails-before: n/a because <reason>` to the PR body.
4. **Review it on GitHub** — actually read the diff (`gh pr diff` /
   files view), don't rubber-stamp. Check: matches the spec, tests
   included and green, on a fix PR `fails-before` green (or its
   exemption justified), `pr-evidence` green and its links actually
   showing what the body claims, README/STATE.md updated if the change is
   meaningful (standing rule), no performance-rule violations.
5. **If review finds a problem**: open an **issue** describing it, push
   fix commits to the same PR referencing the issue (`refs #N`), and
   when fixed, close the issue as solved (`closes #N` in the fixing
   commit/PR comment).
6. **Merge** into `dev` (merge commit, delete branch) once review is
   clean and CI is green. **As of 2026-08-27 the agent merges its own
   PRs again**: open the PR, wait for CI to pass, then merge. Do not
   merge on red or pending CI. (History: auto-merge was authorized
   2026-07-15, revoked 2026-07-20 with the owner merging personally,
   and re-authorized 2026-08-27.) Promotion `dev → prod` still needs
   the owner's explicit OK each time — that has never changed.
7. **Everything is done from the `Taha-Mahmoodi` account** — branches,
   commits, PRs and merges. Set by Taha, 2026-08-28.

   Previously PRs were opened from the `sadeqisaidmohaddes-star` collaborator
   account. That account belongs to a different person, and merging from it
   authored merge commits in his name. It stayed invisible on every PR, because
   their commits carry their normal author, and only surfaced on promotion
   #121, where those merge commits finally entered a diff and the CLA bot
   refused them. Do not open or merge anything from that account again.

## Promotion to prod

When a coherent unit of work on `dev` is **verified** — suite green, the
feature exercised end-to-end per the sandbox/visual protocols — open a PR
`dev → prod` titled `Promote: <what>`, confirm the diff is exactly the
verified work, get it reviewed (the **review gate** below), and merge. If
something on `dev` turns out broken, it simply doesn't get promoted until
fixed — `prod` never waits on a revert.

A promotion needs a review of exactly what it merges, by the owner or by a
second agent whose job is to disprove the PR's claims (#574). The required
`review-verdict` status on `prod` (see **Branch protection and the review
gate** at the end) turns green only after one of:

- an approving GitHub review of the PR's head commit by an account other
  than the PR author, or
- a PR comment whose **first line is exactly `VERDICT: MERGE`**, posted
  after the PR's latest push, that links the review record:

  ```
  VERDICT: MERGE

  Review: <https:// link to the review record, or [[reviews/<pr>]] in Elara>
  Head reviewed: <sha>
  ```

`VERDICT: CHANGES` as the first line (followed by the blocking list) keeps
it red. A push after the verdict makes the verdict stale: review the new
commits and post again. The full promotion order: open the PR, wait for
every required check (on `prod` the lab runs its full tier and the benchmark
all five suites, about an hour), review, post the verdict, merge.

The promotion PR uses the same template, and `pr-evidence` checks it like
any other PR. Its Evidence section links (full URL) the green CI run on
the `dev` head being promoted; the carried PRs can be listed as `#N`,
which counts as a link for a claim on the same bullet. "100% green" or
"verified" without those links fails (promotion #334 claimed "100% green"
while its CI failed on lint).

The image is published only for a `prod` commit whose CI `checks` job
passed (#573). The push to `prod` starts **CI**, and CI's `publish` job
(`needs: checks`, calling `publish.yml`) builds and pushes the image in
the same run, on the same commit. If `checks` fails, `publish` is skipped
and the hosted instance stays on the previous image — fix on `dev` and
promote again. (Before this, publish ran on every `prod` push regardless:
promotion #334 shipped an image while its CI failed on lint.)

After the merge, confirm the CI run on `prod` ended with `publish`
succeeded (`gh run list --workflow ci.yml --branch prod`, then
`gh run view <id>`). Until it does, the hosted instance is still on the
previous image.

The push event can be late. On 2026-10-12, promotion #392 (`1c1ea12`,
merged 08:59:14Z) showed no run at first; `publish.yml` was dispatched by
hand 88 s later, and at 09:01:08Z the push event fired CI and Publish
anyway, so the image was published twice. If no CI run shows up for the
merge commit, **wait a few minutes** and check
`gh run list --commit <sha>`. Only if there is still no CI run, start it
by hand: `gh workflow run ci.yml --ref prod`. It runs `checks` and then
publishes, exactly like a push. This uses `prod`'s copy of `ci.yml`, so
it only works once the #573 change has been promoted to `prod` (before
that, `prod`'s `ci.yml` has no `workflow_dispatch`).

If CI passed on the `prod` head but `publish` failed (e.g. registry
outage), re-run the failed jobs in that CI run or dispatch
`gh workflow run publish.yml --ref prod`. Only the current head of a
branch is published: the `ci-gate` job refuses a commit that is no
longer the head of its branch, so re-running an old `prod` CI run fails
at the gate instead of moving `latest` back. To roll back, promote a
revert.

`publish.yml` dispatches and `v*` tag pushes start with that `ci-gate`
job; it also finds the latest completed CI `checks` job for the commit
(push or dispatch runs only, so the exact commit was tested; cancelled
runs ignored) and refuses to publish unless it succeeded. When CI calls
`publish.yml`, the gate reads that CI run's own `checks` job instead. A
`v*` tag pushed before CI on its commit has finished is refused and not
retried: wait for CI on the commit, then
`gh workflow run publish.yml --ref <tag>`. Overriding the CI result is an
owner decision:
`gh workflow run publish.yml --ref prod -f force=true -f reason="<why>"`;
the gate then logs a warning and a run-summary entry naming who started
the run, the commit, the CI result and the reason. `force` does not
override the branch-head check. `-f dry_run=true` builds without pushing.

The gate only exists in commits that contain it. Older commits and
branches without it still carry the old ungated `publish.yml`, so a `v*`
tag pushed on such a commit, or a `publish.yml` dispatch on such a
branch, publishes without any check. Don't do either.

## Issues

- Bugs, review findings, and deferred work all become issues — labeled
  (`bug`, `enhancement`, `deferred`), referenced from the PRs that fix
  them, closed with the fix, never closed silently.
- External contributions: triage the same way (see issue #9 for the
  pattern — premature ideas get recorded and deferred, not dropped).

## CI

GitHub Actions runs typecheck + lint + tests on every PR (added with the
first code scaffold), then `pnpm -C server check-notes` over the notes the
server tests left behind (#578: every live note's file exists, parses, and
equals its row). The server tests include the MCP secret scan
(`server/test/mcp-secret-scan.test.ts`, #577): every MCP tool and prompt
is called against seeded secrets and must return none, and a newly
registered tool fails CI until it has a fixture step there. Green CI is a
merge precondition on `dev` and a promotion precondition on `prod`.

**Fails-before** (`.github/workflows/fails-before.yml`, job
`fails-before`, #575) runs on every PR to `dev` whose title starts with
`fix:` / `fix(scope):` / `fix!:` / `fix(scope)!:` (case-insensitive;
other PRs pass as "skipped", so the author's choice of title decides
coverage). It also re-runs when the title, body or labels change. The
workflow runs the base commit's copy of `.github/scripts/fails-before.mjs`,
so a PR cannot edit the check it is judged by; when the base has no copy
it runs the PR's, and the summary says which. The job:

1. diffs the PR against its base (`base...head`). Test side:
   `server/test/**` and `client/src/test/**` (tests, helpers, fixtures,
   global setup), `client/src/**/*.test.ts(x)` and
   `client/src/**/__snapshots__/**`. Everything else is source.
2. checks out the base commit (the first parent of GitHub's PR merge
   commit) in a separate worktree, copies the PR's test-side files over
   it, runs `pnpm install --frozen-lockfile`, and runs only the
   `*.test.ts(x)` files the PR adds or changes (server ones against a
   pgvector container, like `checks`).
3. passes if at least one of those tests **fails on an assertion or
   error of its own**. These do not count, and are reported separately:
   - "suite failed to load": the file fails to load (missing module,
     syntax error, top-level throw, or a suite-level error before any test
     fails). It shows the import broke, not that the test catches the bug.
   - "failed on a missing export": a test imports a name the base
     module does not export yet. Vitest still loads the file and the
     name is `undefined`, so the test fails with
     `(0 , __vite_ssr_import_0__.newFn) is not a function`,
     `... is not a constructor`, `Cannot read properties of undefined` or
     `expected undefined to ...`. A failure whose message names a
     `__vite_ssr_import_N__` / `__vi_import_N__` binding never counts.
     The job also imports each module a changed test file imports (from
     `./`, `../` or `@/`) on base and, if a name is missing, on the PR
     head: names present only on the head are exports the PR adds, and
     **no failure in a file that imports one counts**. Put the
     fails-before test in a file that reaches the fixed code through
     exports the base already has.

   Vitest does not typecheck, so a test that only stops type-checking on
   base is not a failure. The job fails if every changed test passes on
   base, if only failures that do not count remain, or if the fix PR
   changes no test file.

The job summary lists every changed test file with its result on base
(the failing test names and first error line, the load error, or the
missing exports). Escape hatch: label `no-fails-before` plus a
`Fails-before: n/a because <reason>` line in the PR body, with at least
10 characters of reason after `because` (a `<...>` placeholder does not
count); the job then runs no test, passes, and prints the justification.
The label without a valid line fails. The pure logic has unit tests in
`.github/scripts/fails-before.test.mjs`, run by `checks` (`node --test`).
`fails-before` is a required status check on `dev` and `prod` (#574). On
PRs to `prod` the job is skipped (a skipped required check passes): each
fix a promotion carries passed it on its PR to `dev`. It is a guard, not a
proof: a test that fails on base only because the diff is missing (for
example asserting on source text) still counts, so reviewers read the
failing test names in the summary.

**PR evidence** (`.github/workflows/pr-evidence.yml`, job `pr-evidence`,
#579) runs on every PR to `dev` or `prod` (promotions included) when it
is opened, pushed, reopened, edited or marked ready, so a body edit
re-runs it. Like fails-before, it runs the base commit's copy of
`.github/scripts/pr-evidence.mjs` when the base has one. Here, a **link**
is a full URL to a GitHub Actions run, PR, issue, commit or file
(`blob/`, `tree/`) of this repository; links to other repositories never
count. It fails when:

1. the Evidence section is missing: no heading containing the word
   Evidence (`## Evidence`, `### Tests / Evidence`, any level) and no
   `**Evidence**` / `**Evidence:**` line, or only HTML comments under it.
   The unfilled template fails.
2. the Evidence section has no link (`TBD`, `n/a`, "Tested locally.", a
   lone sub-heading, `#123` alone all fail). Before CI has run, link the
   issue or the head commit; editing the body re-runs the check once the
   run link is added.
3. the Evidence section keeps a template placeholder such as `<id>` or
   `<reason>` (HTML tags and `<https://...>` autolinks are not
   placeholders).
4. a claim matching one of the `CLAIMS` patterns in the script (the only
   list; for example `100%` / `100 percent`, `verified`, "all 49 tests
   pass", "922 tests passing", `476/476`, "0 errors", "no regressions",
   "CI is green", "tested end-to-end", `fully tested` / `fully covered`,
   `production-ready`, `stable`, `remediated`) appears in a sentence, list
   item or table row with no link and no `#123` / `owner/repo#123`
   reference. A list item is judged together with its parent items and
   its nested items, so `- All tests pass:` followed by a sub-bullet with
   the run URL passes; sibling items and the next sentence do not count.
   Reference-style links (`[run][1]` plus `[1]: <url>`) count.

Matching is case-insensitive on whole words (`unstable`, `unverified` do
not count), after Unicode normalisation (`１００％` is `100%`) and with
zero-width characters removed. Headings, table header rows, HTML
comments, fenced code and inline code (backticks, `<code>`) are not
checked for claims, so quoting a word in backticks (`` `stable` ``)
mentions it without claiming it. There is no exemption label: a true
claim can link its run, and a word that is not a claim can be quoted or
reworded, so a label would only let through the unlinked claims this
check exists to stop. Dependabot PRs (`dependabot[bot]`) are skipped:
their bodies are upstream release notes, not claims by the author. A PR
from GitHub's Revert button (title `Revert "..."`, body
`Reverts owner/repo#N`) needs no Evidence section, but its claims are
still checked. The job summary lists each failing sentence or item with
its claims. Unit tests: `.github/scripts/pr-evidence.test.mjs`, run by
`checks`. Like fails-before, it is a required status check on `dev` and
`prod` (#574). It checks that a claim has a link, not that the link shows
the claim: reviewers open the links (step 4 above).

**Elara lab** (`.github/workflows/elara-lab.yml`, job `lab`, #576) runs
the integration tests where the collab relay, the note store, the disk,
Postgres and MCP meet, against an instance built from the commit with the
repo's `docker-compose.yml`. Fast tier (~6 min) on PRs to `dev` that
change anything the image is built from (`server/**`, `client/**`, the
root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
`tsconfig.base.json`, `Dockerfile`, `.dockerignore`,
`docker-compose.yml`) or the lab (`lab/**`); client collab code also adds
the browser test. Full tier (about an hour) nightly on `dev`, on every PR
to `prod`, and by `gh workflow run elara-lab.yml --ref <branch>`. A gate
compares the results with `lab/known-defects.json` (every check that fails
or is inconclusive today, each with its open issue): a new failure, a new
inconclusive check, a known defect that no longer shows, a regex entry
that covers more than one kind of check, or a crashed test turns it red.
A fix that makes a known defect pass removes its entry in the same PR.
`lab` is a required status check on `dev` and `prod` (#574): when `plan`
picks no tier the job is skipped, which passes; `plan` is required too, so
a failed `plan` (which skips `lab`) cannot pass as a skipped lab. Tiers,
the baseline, how to add a test: `docs/agents/lab.md`.

**Premise benchmark** (same workflow, jobs `bench` ×3 and `bench-gate`,
#570/#572) measures the tokens and calls a scripted agent needs to reach
the evidence for a question with Elara's MCP tools, against ripgrep +
ranged reads on a checkout of the same pinned commit, plus hit@k, MRR,
NDCG@10 and line-level precision/recall. It runs on three lab instances of
its own, never against production (the runner refuses any other base
URL), and gates their median. The `chapters` suite runs on PRs to `dev`
that touch search, extraction or ingestion, MCP, the schema, server
start-up/config, the image's dependencies or the benchmark; all five
suites run nightly, on every PR to `prod` and by hand
(`-f tier=none -f bench=all`). The gate
(`.github/scripts/bench-gate.mjs`, base copy on PRs) fails when Elara's
hit@5 drops by more than two questions of a suite or its mean
tokens-to-gold rises by more than 10 % against the **base** commit's
`benchmarks/baseline.json`; when the suite changed (questions, keywords,
policy config or harness source) unless the PR has the label
`bench-suite-change` and a `Bench-suite-change: <why>` line; when the PR's
baseline is worse than the base's unless it has `bench-baseline-lowered`
and a `Bench-baseline-lowered: <why>` line; and when the run no longer
matches the PR's baseline (an improvement is recorded in the same PR with
`--write-baseline` from the PR's own three instances). Labels are read when
the gate runs: re-run `bench-gate` after adding one. The delta table is in
the job summary. `bench-gate` is a required status check on `dev` and
`prod` (#574); it is skipped (passes) when no suite applies, and it fails
when a `bench` instance did not produce results.
Method, thresholds and the only publishable numbers:
`benchmarks/README.md`.

## Branch protection and the review gate

`dev` and `prod` have branch protection with `enforce_admins: true`
(admins cannot bypass it) and `strict: true` (the PR must be up to date
with its base). Required status checks (#574):

| check | workflow | `dev` | `prod` | why it always reports |
|---|---|---|---|---|
| `checks` | `ci.yml` | required | required | runs on every PR |
| `pr-evidence` | `pr-evidence.yml` | required | required | runs on every PR to `dev` or `prod` |
| `fails-before` | `fails-before.yml` | required | required | skipped (passes) for titles that are not `fix`, and on `prod` |
| `plan` | `elara-lab.yml` | required | required | runs on every PR to `dev` or `prod` |
| `lab` | `elara-lab.yml` | required | required | skipped (passes) when `plan` picks no tier |
| `bench-gate` | `elara-lab.yml` | required | required | skipped (passes) when no benchmark suite applies |
| `review-verdict` | `review-verdict.yml` | informational | required | a commit status set on every PR event, review and comment |

A skipped job counts as passing; a check that never reports keeps the PR
at "Expected — Waiting for status to be reported" forever. So a required
check must come from a workflow that starts on every PR to that branch with
no path filter, and renaming a job renames its check: change the
protection in the same PR. The `bench (1)`..`bench (3)` jobs are not
required; `bench-gate` judges them. Read the settings with
`gh api repos/PIIIX-org/chapters/branches/<branch>/protection`.

**Review gate** (`.github/workflows/review-verdict.yml`, script
`.github/scripts/review-verdict.mjs`, unit tests
`.github/scripts/review-verdict.test.mjs` run by `checks`). On every PR
event (opened, pushed, reopened, edited, ready), review (submitted, edited,
dismissed) and PR comment (created, edited, deleted) the job `evaluate`
reads the PR through the API and sets the commit status `review-verdict`
on the PR's current head. It is a commit status, not the job's check run,
because a comment-triggered run belongs to the default branch and its
check run would never show on the PR. The job itself is green whenever it
could evaluate; read the `review-verdict` status (its details link opens
the run, whose summary lists what counted and how to pass). The rules:

- Only users with write access count (`OWNER`, `MEMBER`, `COLLABORATOR`);
  bots never count.
- An approval counts when it is that reviewer's latest decisive review, is
  on the current head commit, and the reviewer is not the PR author. A
  reviewer's latest `CHANGES_REQUESTED` blocks.
- A comment counts when its first non-empty line is exactly
  `VERDICT: MERGE` or `VERDICT: CHANGES` (not bold, not quoted). Only
  comments posted after the head became the head count: after the latest
  of the head commit's committer date, the first check suite GitHub created
  for that commit (its push, which a backdated commit cannot hide) and the
  last force-push of the PR branch. The latest such comment decides.
- `VERDICT: MERGE` needs a link to the review record: an `https://` URL
  (not this PR's own page) or an Elara `[[...]]` link. A bare path or
  `#123` is not a record.

On `prod` it is required; on `dev` (and any other base) it reports but is
not required, so a fix PR can carry its review verdict without blocking.
If the status looks stale, re-run the newest **Review verdict** run, or
edit the PR body.

What the gate does and does not guarantee. Everything here is done from
one account (`Taha-Mahmoodi`), and GitHub never lets an author approve
their own PR, so `required_pull_request_reviews` would block every
promotion and is not used. The verdict comment is posted by that same
account, so GitHub cannot tell the reviewing agent from the author: this is
a **procedural gate, not an identity guarantee**. It guarantees that a
`VERDICT: MERGE` naming a review record was posted after the last push, and
nothing about who wrote it or whether the review was any good. Further
limits:

- On PR events the workflow file comes from the PR (and the script from
  the base, or from the PR when the base has none); on comment events both
  come from `dev`. Anyone who can push can edit or forge the status, like
  every other check. A promotion that touches `.github/workflows/**` or
  `.github/scripts/**` needs the reviewer to read those changes first.
- Comment events run the default branch's workflow, so posting a comment
  re-evaluates only once this workflow is on `dev`.
- PRs from forks get a read-only token: no status is set and a PR to
  `prod` stays blocked (promotions always come from `dev`).
