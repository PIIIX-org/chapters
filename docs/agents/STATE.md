# STATE

Resume anchor. The block between the `state:generated` markers is rebuilt from GitHub (issues, milestones, promotions, runs on `dev`) by `.github/scripts/state-md.mjs`; the `state-md.yml` workflow pushes `bot/state-md` when `dev`'s block is stale. Run `node .github/scripts/state-md.mjs --write` only in the PR that lands the bot's block or one that edits the hand-written part, not in every fix PR (`github-workflow.md`, STATE.md). Don't edit inside the markers. Keep the hand-written part below short and update it when it changes.

<!-- state:generated:start -->
<!-- Built by .github/scripts/state-md.mjs from GitHub data (workflow .github/workflows/state-md.yml). Edits between these markers are overwritten. -->
- **Last promotion to `prod`**: #660 Promote: Elara study phase 1 (guardrails and security) (merged 2026-10-17, `5c5bdc0`).
- **Checks on `dev`**: CI (latest push run) success; nightly lab (full tier) **failure**; bench-gate (all suites) success. History: [CI](https://github.com/PIIIX-org/chapters/actions/workflows/ci.yml?query=branch%3Adev), [lab](https://github.com/PIIIX-org/chapters/actions/workflows/elara-lab.yml?query=branch%3Adev+event%3Aschedule).
- **Phases** (milestones, closed of total): [Phase 0: owner actions](https://github.com/PIIIX-org/chapters/milestone/1) 4/6, [Phase 1: guardrails and security](https://github.com/PIIIX-org/chapters/milestone/2) 25/25, [Phase 2: stop data loss](https://github.com/PIIIX-org/chapters/milestone/3) 0/38, [Phase 3: the premise (fewer tokens, exact answers)](https://github.com/PIIIX-org/chapters/milestone/4) 0/61, [Phase 4: knowledge truth and memory](https://github.com/PIIIX-org/chapters/milestone/5) 0/29, [Phase 5: everything else](https://github.com/PIIIX-org/chapters/milestone/6) 0/43.
- **Open issues**: [178](https://github.com/PIIIX-org/chapters/issues): P0 60, P1 83, P2 30, no priority 5; `bug` 8, `security` 2, `decision` 2, `deferred` 2.
- **Owner actions** (label `owner`):
  - #589 [fix 192] Revoke the 5 GitHub tokens exposed before #383 (P0)
  - #664 Production deploys on the push to prod, before CI publishes the gated image (#590 is… (P1)
  - #636 Production uptime
- **In progress: [Phase 2: stop data loss](https://github.com/PIIIX-org/chapters/milestone/3)** (38 open, owner actions excluded):
  - #403 MCP/REST edits are attributed to collab/null in the audit trail when the collab relay is… (P0)
  - #408 edit_note replaces the whole body and deletes text a user is typing at the same moment (P0)
  - #409 Backup restore crashes and loses attachments, trash, revisions and MFA secrets (P0)
  - #410 A repository is never polled again after one successful webhook (P0)
  - #411 note_history returns full bodies of every revision with no limit (hang and OOM) (P0)
  - #437 [fix 35] All tool input schemas .strict(): unknown arguments rejected with the real… (P0)
  - #438 [fix 36] edit_note frontmatter merges per key, with explicit replace:true and removeKeys (P0)
  - #474 [fix 74] read_note serves the live document when it is loaded, not the debounced file on… (P0)
  - #475 [fix 75] Compare-and-set: a stale base is three-way merged; clean merges apply and report… (P0)
  - #476 [fix 76] Whole-markdown writes accepted only as a structural diff against the live doc (P0)
  - #477 [fix 77] Every write returns {rev, status: applied|merged|conflicted|retry, diff_stats,… (P0)
  - #478 [fix 79] Atomic append_note / upsert_note so read-then-write appends are never lost (P0)
  - … and 26 more: https://github.com/PIIIX-org/chapters/milestone/3
- **Open bugs** (label `bug`):
  - #403 MCP/REST edits are attributed to collab/null in the audit trail when the collab relay is… (P0)
  - #408 edit_note replaces the whole body and deletes text a user is typing at the same moment (P0)
  - #409 Backup restore crashes and loses attachments, trash, revisions and MFA secrets (P0)
  - #410 A repository is never polled again after one successful webhook (P0)
  - #411 note_history returns full bodies of every revision with no limit (hang and OOM) (P0)
  - #621 Import applies shares from the archive manifest without asking (P1)
  - #617 Web client logs a 401 console error after logout (P2)
  - #619 Attachment upload drops non-ASCII file names (P2)
<!-- state:generated:end -->

- **Product**: **Elara**; the repo keeps the name `chapters`. Current work: the fixes from the Elara AI-performance study (Elara vault notes `audit/2026-10-14-ai-performance-study` and its round-2 follow-up), one GitHub issue per fix-list item, grouped by the `Phase N` milestones above; plan in the Chapters vault `fixes/index`, hand-off `fixes/handoff-phase-1`. Production (`chapters.piiix.org`) redeploys by itself when a new `prod` image is published, and since #590 the image is published only after CI passes on that `prod` commit. A promotion is a PR `dev`→`prod` with every required check green (full lab tier and bench on its head) and a `VERDICT: MERGE` comment from an independent review, then a fast-forward push of the reviewed head (`git push origin <sha>:prod`).
- **Benchmarks**: the TP-01..TP-15 numbers (`docs/benchmarks/`) are retracted: runners never merged, run against prod, impossible numbers. Replaced by the premise benchmark (#570/#572, `benchmarks/README.md`): `bench` ×3 + `bench-gate` jobs in the lab workflow, Elara MCP vs ripgrep + ranged reads on 5 pinned repos, gate on the median hit@5 and tokens-to-gold against `benchmarks/baseline.json`. Today: Elara finds the right file more often on 3 of 5 repos but, where both reach the evidence, grep is 2-5x cheaper (whole-file `read_file`). Search ties are unordered (#623).
- **Previous work**: UI redesign (#206), OKF v0.2 (#209–#213), shell (#218–#239), hardening (#244–#277), MCP prompts and perspectives, mobile cards (2026-10-09), note repair (#391/#395), git credential scrub (#383/#394), study fixes #400, #405, #398, #402 (promoted in #407), study phase 1 guardrails and security (#590–#655: CI gates, lab and benchmark in CI, review-verdict, token scopes and capabilities, secret scan, restart alerts, agent trial).
- **Architecture Traps**:
  - `prod` == `dev` needs Taha's explicit OK. PRs target `dev` directly, never stacked.
  - 1 container + 1 Postgres per customer. Control plane in separate private repo.
  - Collab is a person, no autosave PUT (CRDT is the note). Viewer read-only forever.
  - Exact seq scan for semantic edge recompute (#123). Mutation-verify every test.
  - MCP is Streamable HTTP only (`/mcp`, `/elara/mcp`); no stdio. Hosted at `chapters.piiix.org`; `elara.piiix.org` is not live.
- **Suite**: server + client Vitest suites run in CI (`checks`) on every PR. `server/test/mcp-secret-scan.test.ts` (#577) calls every MCP tool and prompt against seeded secrets: a new tool fails CI until it has a fixture step there. A `fix:` PR to `dev` also runs `fails-before` (#575): its changed tests must fail on the base commit, or the PR carries label `no-fails-before` + a `Fails-before: n/a because ...` line. Every PR to `dev` or `prod` runs `pr-evidence` (#579): the body needs an Evidence section with at least one link into the repo (template `.github/pull_request_template.md`), and claims need a link next to them; rules in `github-workflow.md`. `attribution` (#580, not required) fails a PR from a `fix`, `ci`, `docs`, `feat`, `chore` or `test` branch (`fix/...` or `fix-...`) with a commit lacking a `Co-Authored-By:` trailer, unless it has label `human-only`. Bugs are filed as issues with the bug form (`.github/ISSUE_TEMPLATE/bug.yml`) and a `found-by:*` label (#581). The **Elara lab** (#576, `docs/agents/lab.md`) builds the commit with docker compose and runs the integration tests (collab relay, store, disk, MCP): fast tier on PRs to `dev` that change the image inputs (`server/**`, `client/**`, root manifests and lockfile, Dockerfile, compose) or `lab/**`; full tier nightly and on PRs to `prod`. Its gate fails on a failed or inconclusive check outside `lab/known-defects.json` or a listed defect that no longer shows; a fix removes its entry. Required status checks on `dev` and `prod` (#574): `checks`, `pr-evidence`, `fails-before`, `plan`, `lab`, `bench-gate`; `prod` also requires `review-verdict`, which passes only on an approving review of the head by another account with write permission or a `VERDICT: MERGE` comment (first line) posted after the latest push that names the head (`Head reviewed: <sha>`) and links the review record; the reviewer is a separate Opus session with an adversarial brief, not a different model (procedural, not an identity check). Promotions are fast-forward pushes of the reviewed head (`git push origin <sha>:prod`), so `prod` stays an ancestor of `dev` (`github-workflow.md`, Promotion to prod; Branch protection and the review gate).
- **Deferred**: cli-visualizer (#9, assigned), partial restore (#261), per-type notification prefs (#263).
- **Decided against (do NOT re-open)**: WebMCP browser standard (adr-001), Leiden (#265), graph DB (#268), GraphRAG (#267), cross-file calls (#266).
