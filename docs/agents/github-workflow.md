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
3. **Open a PR** targeting `dev`. The PR body says what changed and why,
   and references any spec/plan/issue it implements.
4. **Review it on GitHub** — actually read the diff (`gh pr diff` /
   files view), don't rubber-stamp. Check: matches the spec, tests
   included and green, README/STATE.md updated if the change is
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

Both `dev` and `prod` enforce strict GitHub branch protection with
`required_status_checks` on `checks` and `enforce_admins: true`. No PR
can be merged unless all CI checks are green; bypassing is blocked at the
repository level.
