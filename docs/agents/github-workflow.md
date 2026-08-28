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
7. **Merge from `Taha-Mahmoodi`, not from the PR-opening account.** The CLA
   bot's allowlist is `Taha-Mahmoodi,dependabot[bot]`, and a squash/merge
   commit is authored by whoever merges. Merging from the collaborator account
   puts an unsigned committer into history — invisible on the PR itself
   (its commits carry their normal author) and surfacing later on the
   promotion PR, where those merge commits finally enter the diff. That is
   exactly how promotion #121 got blocked. Set by Taha, 2026-08-28.

8. **PRs are opened from `sadeqisaidmohaddes-star`'s GitHub account**
   (write-collaborator on this repo as of 2026-07-20), not
   `Taha-Mahmoodi` — switch the active `gh` account
   (`gh auth switch --hostname github.com --user
   sadeqisaidmohaddes-star`) before `git push`/`gh pr create`, and
   switch back to `Taha-Mahmoodi` afterward. Commit authorship is
   unaffected — commits still carry their normal author.

## Promotion to prod

When a coherent unit of work on `dev` is **verified** — suite green, the
feature exercised end-to-end per the sandbox/visual protocols — open a PR
`dev → prod` titled `Promote: <what>`, confirm the diff is exactly the
verified work, and merge. If something on `dev` turns out broken, it
simply doesn't get promoted until fixed — `prod` never waits on a revert.

## Issues

- Bugs, review findings, and deferred work all become issues — labeled
  (`bug`, `enhancement`, `deferred`), referenced from the PRs that fix
  them, closed with the fix, never closed silently.
- External contributions: triage the same way (see issue #9 for the
  pattern — premature ideas get recorded and deferred, not dropped).

## CI

GitHub Actions runs typecheck + lint + tests on every PR (added with the
first code scaffold). Green CI is a merge precondition on `dev` and a
promotion precondition on `prod`.
