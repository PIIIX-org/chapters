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
   changes. `gh pr create --body`, `--body-file` and `--fill` never load
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
verified work, and merge. If something on `dev` turns out broken, it
simply doesn't get promoted until fixed — `prod` never waits on a revert.

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
`fails-before` is not a required status check yet; branch protection is
fix-list item 177. Until then, treat a red `fails-before` on a fix PR as
blocking review. It is a guard, not a proof: a test that fails on base
only because the diff is missing (for example asserting on source text)
still counts, so reviewers read the failing test names in the summary.

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
`checks`. Like fails-before, it is not a required status check yet (item
177): treat a red `pr-evidence` as blocking review. It checks that a
claim has a link, not that the link shows the claim: reviewers open the
links (step 4 above).

**Elara lab** (`.github/workflows/elara-lab.yml`, job `lab`, #576) runs
the integration tests where the collab relay, the note store, the disk,
Postgres and MCP meet, against an instance built from the commit with the
repo's `docker-compose.yml`. Fast tier (~10 min) on PRs to `dev` that
change `server/**`, `lab/**`, `docker-compose.yml` or `Dockerfile`; full
tier (over an hour) nightly on `dev`, on every PR to `prod`, and by
`gh workflow run elara-lab.yml --ref <branch>`. A gate compares the
results with `lab/known-defects.json` (every check that fails today, each
with its open issue): a new failure, a known defect that now passes, or a
crashed test turns it red. A fix that makes a known defect pass removes
its entry in the same PR. Not a required status check yet (item 177):
treat a red lab run as blocking review. Tiers, the baseline, how to add a
test: `docs/agents/lab.md`.

Both `dev` and `prod` enforce strict GitHub branch protection with
`required_status_checks` on `checks` and `enforce_admins: true`. No PR
can be merged unless all CI checks are green; bypassing is blocked at the
repository level.
