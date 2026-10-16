# Chapters — GitHub Workflow

Two long-lived branches, everything else is short-lived.

## Branches

- **`dev`** (default) — integration branch. All work lands here via PR.
- **`prod`** — stable branch. Only ever receives promotions from `dev`.
  What's on `prod` is verified, working software.
- Feature branches: `<type>/<short-topic>` off `dev` — types: `feat`,
  `fix`, `ci`, `docs`, `chore`, `test` (`<type>-<topic>` is checked the
  same way). Deleted after merge. `bot/` is for branches a workflow writes
  (`bot/state-md`, see **STATE.md** under CI); nobody else pushes there.
- Never commit directly to `dev` or `prod`. No exceptions, including docs.

## The change cycle

Every change — code, spec, doc — follows the same loop:

1. **Branch** off `dev`.
2. **Commit + push** (early and often, per the resume protocol in
   `handling-protocols.md`). An agent ends every commit message with a
   `Co-Authored-By: <model> <email>` trailer (for example
   `Co-Authored-By: Claude Opus <noreply@anthropic.com>`), the only record
   that an agent wrote it (step 7); the `attribution` check (see CI) flags
   commits without one.
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
   showing what the body claims, README and the hand-written part of
   STATE.md updated if the change is meaningful (standing rule), no
   performance-rule violations.
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
   commits, PRs and merges. Set by Taha, 2026-08-28. Because agents and the
   owner share the account, agent commits carry the `Co-Authored-By`
   trailer (step 2) and a PR the owner writes himself gets the label
   `human-only`.

   Previously PRs were opened from the `sadeqisaidmohaddes-star` collaborator
   account. That account belongs to a different person, and merging from it
   authored merge commits in his name. It stayed invisible on every PR, because
   their commits carry their normal author, and only surfaced on promotion
   #121, where those merge commits finally entered a diff and the CLA bot
   refused them. Do not open or merge anything from that account again.

## Promotion to prod

When a coherent unit of work on `dev` is **verified** — suite green, the
feature exercised end-to-end per the sandbox/visual protocols — it is
promoted with a PR `dev → prod` titled `Promote: <what>`, reviewed (the
**review gate** below) and then fast-forwarded. If something on `dev`
turns out broken, it simply doesn't get promoted until fixed — `prod` never
waits on a revert.

A promotion needs a review of exactly what it merges, by the owner or by a
second agent whose job is to disprove the PR's claims (#574). Fix-list item
177 asked for that agent to run on a *different model*. It does not: the
owner requires every study agent to run on Claude Opus, so the reviewer is a
**separate Opus session** that did not write the PR, started with an
adversarial brief (find what is wrong, verify every claim against its
linked run) and no access to the author's conversation. Independence comes
from the separate session and the brief, not from a different model, so
blind spots the model shares with the author are not covered.

The procedure, in order:

1. **Keep `prod` an ancestor of `dev`.** A promotion merged with the merge
   button adds a merge commit that only `prod` has. With `strict: true` a
   later promotion can then show as `BEHIND`, and "Update branch" cannot
   fix that, because it would push to protected `dev`. GitHub has not
   enforced this every time: #407 merged while `prod` had commits its head
   lacked. Check with
   `gh api repos/PIIIX-org/chapters/compare/dev...prod --jq .ahead_by`;
   it should be `0`. If it is not, sync first:
   - branch off `dev` and run `git merge --no-ff origin/prod`. The prod-only
     commits are merge commits with no file changes, so the diff is empty;
   - open a PR to `dev` titled
     `chore: merge prod back into dev (zero file changes)`;
   - merge it with **Create a merge commit**. A squash or rebase merge drops
     `prod`'s parents and fixes nothing.

   Do this before opening the promotion, because it moves `dev`'s head. The
   first sync, for the 12 promotion merge commits up to #407, is #627.
2. **Open the promotion PR** `dev → prod` and wait for every required
   check. On `prod` the lab runs its full tier and the benchmark all five
   suites. Don't merge anything into `dev` until the promotion is done: a new
   `dev` head is a new PR head, which re-runs every check and makes the
   verdict stale.
3. **Review** at the head commit, then post the verdict as a PR comment
   (format below), or approve on GitHub from another account with write
   permission. `review-verdict` turns green.
4. **Promote by fast-forward, not the merge button**:
   `git push origin <reviewed head sha>:prod`. Both rule layers (see
   **Branch protection and the review gate**) accept this push of an open
   PR's head once every required check on that commit is green, and the PR
   is then marked merged with the head as its merge commit. Otherwise the
   push is refused:
   - classic protection, while a required check is red:
     `GH006: Protected branch update failed … Required status check
     "review-verdict" is failing`;
   - ruleset 24421063, for a commit that is not a PR's mergeable head:
     `GH013: Repository rule violations … Changes must be made through a
     pull request`.

   All three outcomes were shown on a scratch branch with classic
   protection and a copy of ruleset 24421063 in #630, with the classic-only
   cases in #626. `prod` is then exactly the reviewed commit and stays an
   ancestor of `dev`. The push starts CI on `prod` and the publish job, as a
   merge does. If the merge button was used anyway, do the step 1 sync
   before the next promotion.

The verdict comment:

```
VERDICT: MERGE

Review: <https:// link to the review record, or [[reviews/<pr>]] in Elara>
Head reviewed: <full head sha, at least 12 hex digits>
Reviewer: <owner, or: separate Opus session, adversarial brief>
```

The first line must be exactly `VERDICT: MERGE` or `VERDICT: CHANGES` (not
bold, not quoted). `Head reviewed` must name the PR's current head.
`Reviewer` is for the record and is not checked. `VERDICT: CHANGES` keeps
the status red until a later `VERDICT: MERGE` comment replaces it. A push
after the verdict makes the verdict stale: review the new commits and post
again.

**Emergency hotfix** (production is broken and the full gate is too slow):
the owner relaxes `prod`'s required checks to `checks` only (the rollback
call in **Branch protection and the review gate**), promotes the fix, and
re-applies the full list right away. Record it in an issue: what was
skipped, why, the commit, and both protection calls. Then run the skipped
gates on that commit after the fact (`gh workflow run elara-lab.yml --ref
prod -f tier=full -f bench=all`). Ruleset 24421063 stays in force, so the
hotfix still needs a PR with `checks` green; it is not relaxed. A fix
committed straight to a branch off `prod` also needs to reach `dev`
(step 1).

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

After the promotion, confirm the CI run on `prod` ended with `publish`
succeeded (`gh run list --workflow ci.yml --branch prod`, then
`gh run view <id>`). Until it does, the hosted instance is still on the
previous image.

The push event can be late. On 2026-10-12, promotion #392 (`1c1ea12`,
merged 08:59:14Z) showed no run at first; `publish.yml` was dispatched by
hand 88 s later, and at 09:01:08Z the push event fired CI and Publish
anyway, so the image was published twice. If no CI run shows up for the
promoted commit (the new `prod` head), **wait a few minutes** and check
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
- **A real bug is an issue with repro steps** (#581). A bug written down
  only in a vault note, a handoff or a PR comment is lost to everyone who
  doesn't read that note. Whoever finds one while dogfooding, testing,
  reviewing or auditing files it before moving on (the vault note can
  link the issue). On github.com the **Bug** form
  (`.github/ISSUE_TEMPLATE/bug.yml`) requires: what happened, steps to
  reproduce, expected, evidence links, found by. Agents filing with
  `gh issue create` (which skips forms) write the same five sections in a
  `--body-file` and add `--label bug --label found-by:<gate>`. Requests
  use the **Feature** form (`feature.yml`). Blank issues are off.
- **`found-by:*` labels** record which gate found a bug, so we can see
  which gates work: `found-by:dogfooding` (using Elara for real work),
  `found-by:test` (unit or CI tests), `found-by:lab` (integration lab or
  benchmark), `found-by:review` (PR or promotion review),
  `found-by:audit` (a study or audit), `found-by:user` (a user report).
  One per bug, set when it is filed; count them with
  `gh issue list --state all --label found-by:<gate>`.
- **No shadow issues.** Don't open an issue only to give a PR a number to
  close: a PR describes its own change. Issues are for bugs, requests and
  deferred work that exist independently of a PR. A review finding on an
  open PR is still an issue (step 5 of the change cycle) because it is a
  bug found by review.
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

**Commit attribution** (`.github/workflows/attribution.yml`, job
`attribution`, #580) runs on every PR to `dev` or `prod` when it is
opened, pushed, reopened, labeled, unlabeled or marked ready. Like
pr-evidence it runs the base commit's copy of
`.github/scripts/attribution.mjs` when the base has one. It applies to PRs
from this repository whose head branch starts with `fix`, `ci`, `docs`,
`feat`, `chore` or `test` followed by `/` or `-` (the agent branch types;
`fix-579-...` counts), and fails if any commit lacks a
`Co-Authored-By: Name <email>` trailer in the last paragraph of its
message (the key in any case, a name and an email in `<>`; a mention in
the body does not count). Exempt: PRs with the label `human-only`, commits
GitHub made and signed in its web UI (committer `GitHub
<noreply@github.com>` **and** a valid GitHub signature: "Update branch",
web edits; a committer email alone is not trusted), every other branch
(`dev` for promotions, `bot/`, `dependabot/`, `lab/`) and fork PRs.
`human-only` is a convention, not an identity check: every agent works
from the same account and can set the label, so it is for the owner's own
PRs only, and a reviewer who sees it on an agent PR treats that as a
finding. Fix a red check with `git commit --amend` (also for a merge
commit you made with `git merge`; or merge with
`-m '...' -m 'Co-Authored-By: ...'` in the first place) or
`git rebase -i` (which drops merge commits) and a force-push. The summary
lists each commit without the trailer. A PR with more than 250 commits
fails (the API lists no more). Unit tests:
`.github/scripts/attribution.test.mjs`, run by `checks`. It is **not** a
required check: it reports on every PR, and making it required is an
owner decision (add `attribution` to both branches' required checks).

**STATE.md** (`.github/workflows/state-md.yml`, #582). The block of
`docs/agents/STATE.md` between `<!-- state:generated:start -->` and
`<!-- state:generated:end -->` is built from GitHub data by
`.github/scripts/state-md.mjs`: the last promotion to `prod`, the latest
CI push run, nightly lab and `bench-gate` on `dev` (a check that did not
pass is shown in bold, with the workflow's history linked, not the run),
the `Phase N` milestones (closed of total, issues only), open issues by
priority and label, `owner` issues, the open issues of the first phase
with work an agent can do, and open `bug` issues (at most 12 per list,
then a count and a link). The rest of the file is hand-written and never
touched. The block holds no time and no run id, so the same GitHub state
always gives the same text.

- **Agents refresh it in their PR.** At the end of every fix PR run
  `node .github/scripts/state-md.mjs --write` (token from `GITHUB_TOKEN`,
  `GH_TOKEN` or `gh auth token`; repository from `--repo`,
  `GITHUB_REPOSITORY` or the `origin` remote) and commit STATE.md if it
  changed. Without `--write` it only prints the block and says whether
  the file is current. It keeps the file's line endings.
- **refresh** job: daily (05:17 UTC), on every push to `dev` and by
  `gh workflow run state-md.yml --ref dev`. When `dev`'s block is stale,
  it writes the diff to the job summary and force-pushes `bot/state-md`
  (one commit on top of `dev` by `github-actions[bot]`, changing only
  STATE.md). When `dev` is current, it closes the bot PR and deletes the
  branch.
  - With the repository secret **`STATE_MD_TOKEN`** it pushes with that
    token and opens or updates the PR
    `docs(state): refresh generated STATE.md block (bot)`, whose fixed
    body links the source run, the commit and the generator in its
    Evidence section. Pushes and PRs made with a personal token start
    workflows, so the PR gets `checks`, `pr-evidence`, `fails-before`
    (skipped: not a `fix` title), `plan`, `lab` and `bench-gate` (both
    skipped: no image or search change) like any PR; `attribution`
    skips `bot/` branches. Review it like any PR (the diff must touch
    only the block) and merge it. The merge is a push to `dev`, which
    regenerates the same block and opens nothing.
  - Without the secret it pushes with `GITHUB_TOKEN` and **fails**, with
    the PR body and the commands in its summary. Pushes and PRs made with
    `GITHUB_TOKEN` run no checks (on scratch PR #634 the push created
    runs in "action required" state that never started a job and cannot
    be approved), and checks from a hand-started (`workflow_dispatch`)
    run never count toward a PR's required checks (GitHub docs,
    "Troubleshooting required status checks"), so a PR it opened could
    never become mergeable. A person lands the block instead: open the PR
    from `bot/state-md` with `gh pr create --base dev --head bot/state-md
    --title '...' --body-file body.md` (a PR a person opens runs its
    checks), or run `--write` in any PR. If a person already opened the
    bot PR, a later refresh pushes with `GITHUB_TOKEN` and its checks do
    not re-run: close and reopen the PR.
  - **Owner action**: create a fine-grained personal access token for
    `PIIIX-org/chapters` with Contents and Pull requests read and write
    and save it as the repository secret `STATE_MD_TOKEN`
    (`gh secret set STATE_MD_TOKEN -R PIIIX-org/chapters`). PRs it opens
    show the token owner as author. A GitHub App would need a step that
    mints its installation token in the job; that is not built.
- **preview** job: on PRs that change the generator, this workflow or
  STATE.md, the summary shows the block and whether the PR's STATE.md is
  current; nothing is written.

Unit tests: `.github/scripts/state-md.test.mjs`, run by `checks`; one of
them fails if STATE.md loses its markers or its hand-written Architecture
Traps and Decided against sections.

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

Two layers of rules apply to `dev` and `prod`, and both must pass:

- **Classic branch protection** on each branch: `enforce_admins: true`
  (admins cannot bypass it), `strict: true` (the PR must be up to date with
  its base), and the required status checks in the table below (#574).
- **Repository ruleset 24421063, "Require CI green before merge"**
  (`gh api repos/PIIIX-org/chapters/rulesets/24421063`). It targets `dev`,
  `prod` and `main` and has no bypass actors
  (`current_user_can_bypass: never`). Rules:
  - `pull_request`: changes go through a PR, 0 approvals,
    `dismiss_stale_reviews_on_push`, all three merge methods allowed.
  - `required_status_checks`: `checks` (integration 15368), strict.

  `gh api repos/PIIIX-org/chapters/rules/branches/<branch>` lists the
  ruleset rules in force on a branch. #574 does not change the ruleset.

Required status checks (classic protection, #574):

| check | workflow | `dev` | `prod` | why it always reports |
|---|---|---|---|---|
| `checks` | `ci.yml` | required | required | runs on every PR |
| `pr-evidence` | `pr-evidence.yml` | required | required | runs on every PR to `dev` or `prod` |
| `fails-before` | `fails-before.yml` | required | required | on `dev` it runs on every PR and passes for titles that are not `fix`; on `prod` it is skipped (passes) |
| `plan` | `elara-lab.yml` | required | required | runs on every PR to `dev` or `prod` |
| `lab` | `elara-lab.yml` | required | required | skipped (passes) when `plan` picks no tier |
| `bench-gate` | `elara-lab.yml` | required | required | skipped (passes) when no benchmark suite applies |
| `review-verdict` | `review-verdict.yml` | — | required | a commit status set on every PR event, review and comment of a same-repo PR to `prod` |
| `review-verdict/dev` | `review-verdict.yml` | informational | — | the same rules on PRs to `dev`; never required |
| `attribution` | `attribution.yml` | informational | informational | runs on every PR to `dev` or `prod`; not required (owner decision) |

A skipped job counts as passing; a check that never reports keeps the PR
at "Expected — Waiting for status to be reported" forever. So a required
check must come from a workflow that starts on every PR to that branch with
no path filter, and renaming a job renames its check: change the
protection in the same PR. The `bench (1)`..`bench (3)` jobs are not
required; `bench-gate` judges them. A head commit whose message contains
`[skip ci]` starts no workflow at all, so its required checks never report:
don't use it on a PR branch. Read the settings with
`gh api repos/PIIIX-org/chapters/branches/<branch>/protection`.

Before `prod` requires `lab` and `bench-gate`, the prod configuration (lab
full tier, all five benchmark suites) must have run green once on `dev`:
`gh workflow run elara-lab.yml --ref dev -f tier=full -f bench=all`.
Otherwise the first promotion is the first run of that configuration, and
a red one blocks it. Rollback for either branch (and the emergency hotfix
path under **Promotion to prod**):
`gh api -X PATCH repos/PIIIX-org/chapters/branches/<branch>/protection/required_status_checks --input <file>`
with `{"strict": true, "checks": [{"context": "checks", "app_id": 15368}]}`.
App 15368 is GitHub Actions. It owns the job check runs and also the
`review-verdict` status, which the workflow posts with its token.

**Review gate** (`.github/workflows/review-verdict.yml`, script
`.github/scripts/review-verdict.mjs`, unit tests
`.github/scripts/review-verdict.test.mjs` run by `checks`). On every PR
event (opened, pushed, reopened, edited, ready), review (submitted, edited,
dismissed) and PR comment (created, edited, deleted) the job `evaluate`
reads the PR through the API and sets a commit status on the PR's current
head. It is a commit status, not the job's check run, because a
comment-triggered run belongs to the default branch and its check run
would never show on the PR. The job itself is green whenever it could
evaluate; read the status (its details link opens the run, whose summary
lists what counted, each verdict author's permission and how to pass).

A status belongs to a **commit, not a PR**, and a promotion's head (the
tip of `dev`) can also be the head of other PRs. So:

- the context depends on the base: `review-verdict` for PRs to `prod`,
  `review-verdict/dev` for PRs to `dev`, and no status at all for any other
  base. A verdict on a `dev → lab/*` PR never marks the commit as reviewed
  for a promotion.
- fork PRs never *set* the status: the job does not run for their PR and
  review events, and on comment events the script refuses them. Since a
  status belongs to a commit, a fork PR whose head is the promotion's head
  still *shows* the promotion's status; that is harmless because
  promotions always come from `dev`.
- two PRs with the same base and the same head have the same diff, so a
  verdict on one is a review of the other. No extra check exists for that
  case. An earlier version refused it, but that let any fork PR with the
  promotion's head turn the required status red.

The rules:

- Only users whose repository permission is admin, maintain or write count,
  read from `GET /repos/{owner}/{repo}/collaborators/{user}/permission` (not
  `author_association`: `MEMBER` is any organisation member and
  `COLLABORATOR` includes read and triage). Bots never count, neither as
  reviewers nor as verdict authors.
- An approval counts when it is that reviewer's latest decisive review, is
  on the current head commit, and the reviewer is not the PR author. A
  reviewer's latest `CHANGES_REQUESTED` blocks.
- A comment counts when its first non-empty line is exactly
  `VERDICT: MERGE` or `VERDICT: CHANGES` (not bold, not quoted). Only
  comments posted after the head became the head count: after the latest
  of the head commit's committer date, the first check suite GitHub created
  for that commit (its push, which a backdated commit cannot hide) and the
  last force-push of the PR branch. The latest such comment decides.
- `VERDICT: MERGE` must have a `Head reviewed: <sha>` line on its own
  whose 12 to 40 hex digits match the start of the current head (post the
  full SHA), and a link
  to the review record: an `https://` URL (not this PR's own page) or an
  Elara `[[...]]` link. A bare path or `#123` is not a record. Prefer a link
  that stays valid (an Elara note, an issue comment), not a file on a branch
  that will be deleted.

If the status looks stale, re-run the newest **Review verdict** run, or
edit the PR body.

What the gate does and does not guarantee. By policy everything is done
from the `Taha-Mahmoodi` account (step 7 of the change cycle), and GitHub
never lets an author approve their own PR, so `required_pull_request_reviews`
would block every promotion and is not used. Two other accounts have write
access (`wafa-khairi-1020`, admin, and `sohrabq`, maintain), and their
approvals and verdicts count. Agents never use them. The verdict comment of
a reviewing agent is posted by the author's own account, so GitHub cannot
tell the reviewer from the author: this is a **procedural gate, not an
identity guarantee**. It guarantees that a `VERDICT: MERGE` naming the head
and a review record was posted after the last push, and nothing about who
wrote it or whether the review was any good. Further limits:

- On PR events the workflow file comes from the PR (and the script from
  the base, or from the PR when the base has none); on comment events both
  come from `dev`. Anyone who can push can edit or forge the status, like
  every other check. A promotion that touches `.github/workflows/**` or
  `.github/scripts/**` needs the reviewer to read those changes first.
- Comment events run the default branch's workflow, so posting a comment
  re-evaluates only once this workflow is on `dev`.
- Required checks are matched by name on the commit, not per workflow
  event, and the newest run of a name is the one that counts. On #626 a
  second PR with the same head started another `checks` run, and #626 went
  back to `BLOCKED` until that run finished. These all add newer runs on
  the promotion's head commit (dev's tip):
  - the nightly lab (`30 2 * * *`, full tier and all suites): a flaky night
    turns an open promotion red, and while it runs the promotion is pending;
  - a `workflow_dispatch` or a `lab/**` push of that commit, which replaces
    `plan`, `lab` and `bench-gate` with a smaller tier's results;
  - another PR with the same head, including a **fork PR** to `prod`. It
    starts `pr-evidence` with its own body (which can be red) and a full lab
    run. First-time contributors need approval before their workflows run
    (`approval_policy: first_time_contributors`); other accounts do not.

  Keep promotions short. Don't dispatch the lab on `dev` or open other PRs
  from `dev` while one is open. If a newer run turns a check red, re-run
  that check on the promotion PR. Not enforced: a prod-only job name would
  close this.
