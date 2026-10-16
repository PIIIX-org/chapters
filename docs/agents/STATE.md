# STATE

Resume anchor. The block between the `state:generated` markers is rebuilt from GitHub (issues, milestones, promotions, runs on `dev`) by `.github/scripts/state-md.mjs`; the `state-md.yml` workflow opens or updates a `bot/state-md` PR when it changes (daily and on every push to `dev`; `github-workflow.md`, STATE.md). Don't edit inside the markers. Keep the hand-written part below short and update it when it changes.

<!-- state:generated:start -->
<!-- Built by .github/scripts/state-md.mjs from GitHub data (workflow .github/workflows/state-md.yml). Edits between these markers are overwritten. -->
- **Last promotion to `prod`**: #407 Promote: Elara study fixes (#400, #405, #398, #402) and docs (#406) (merged 2026-10-15, `111e3f1`).
- **Checks on `dev`**: CI (latest push run) success; nightly lab (full tier) **failure** ([run](https://github.com/PIIIX-org/chapters/actions/runs/38867185912)); bench-gate (all suites) success. History: [CI](https://github.com/PIIIX-org/chapters/actions/workflows/ci.yml?query=branch%3Adev), [lab](https://github.com/PIIIX-org/chapters/actions/workflows/elara-lab.yml?query=branch%3Adev+event%3Aschedule).
- **Phases** (milestones, closed of total): [Phase 0: owner actions](https://github.com/PIIIX-org/chapters/milestone/1) 0/4, [Phase 1: guardrails and security](https://github.com/PIIIX-org/chapters/milestone/2) 9/21, [Phase 2: stop data loss](https://github.com/PIIIX-org/chapters/milestone/3) 0/35, [Phase 3: the premise (fewer tokens, exact answers)](https://github.com/PIIIX-org/chapters/milestone/4) 0/60, [Phase 4: knowledge truth and memory](https://github.com/PIIIX-org/chapters/milestone/5) 0/29, [Phase 5: everything else](https://github.com/PIIIX-org/chapters/milestone/6) 0/34.
- **Open issues**: [184](https://github.com/PIIIX-org/chapters/issues): P0 65, P1 92, P2 22, no priority 5; `bug` 8, `security` 2, `decision` 4, `deferred` 2.
- **Owner actions** (label `owner`):
  - #586 [fix 189] Redeploy production (docker compose pull && docker compose up -d) so… (P0)
  - #587 [fix 190] Rotate the webhook secret pasted in chat; decide on the inactive GitHub hook… (P0)
  - #588 [fix 191] Decide whether to keep the upstream rea connection (re-clones every 5 min) and… (P0)
  - #589 [fix 192] Revoke the 5 GitHub tokens exposed before #383 (P0)
- **In progress: [Phase 1: guardrails and security](https://github.com/PIIIX-org/chapters/milestone/2)** (12 open, owner actions excluded):
  - #546 [fix 149] Route every handler through vaultFor/repositoryFor: find_symbols (P0)
  - #547 [fix 150] Scoped-token tests for every tool (P0)
  - #548 [fix 151] Read-only tokens, tool allow-lists, and expiry set at mint time (P1)
  - #549 [fix 152] Pinned tokens can't share, delete or purge their vault or erase history… (P1)
  - #550 [fix 153] Saving or publishing shared graph perspectives requires edit access; global… (P1)
  - #552 [fix 155] Token revocation timing, rate-limit headers, tenant isolation, how note text… (P1)
  - #571 [fix 174] Scheduled agent trial against a staging server; the only published numbers come… (P1)
  - #580 [fix 183] Co-Authored-By on every agent commit; labels like… (P1)
  - #581 [fix 184] Real bugs go into GitHub issues with repro steps, not only into a vault note;… (P1)
  - #582 [fix 185] STATE.md generated from GitHub data so it can't go stale (P1)
  - #583 [fix 186] Alert when the production app restarts (P1)
  - #593 Close remaining git-credential redaction gaps (follow-up to #577/#592) (P1)
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

- **Product**: **Elara**; the repo keeps the name `chapters`. Current work: the fixes from the Elara AI-performance study (Elara vault notes `audit/2026-10-14-ai-performance-study` and its round-2 follow-up), one GitHub issue per fix-list item, grouped by the `Phase N` milestones above. Production (`chapters.piiix.org`) runs a promotion only after a redeploy (`docker compose pull && docker compose up -d`).
- **Benchmarks**: the TP-01..TP-15 numbers (`docs/benchmarks/`) are retracted: runners never merged, run against prod, impossible numbers. Replaced by the premise benchmark (#570/#572, `benchmarks/README.md`): `bench` ×3 + `bench-gate` jobs in the lab workflow, Elara MCP vs ripgrep + ranged reads on 5 pinned repos, gate on the median hit@5 and tokens-to-gold against `benchmarks/baseline.json`. Today: Elara finds the right file more often on 3 of 5 repos but, where both reach the evidence, grep is 2-5x cheaper (whole-file `read_file`). Search ties are unordered (#623).
- **Previous work**: UI redesign (#206), OKF v0.2 (#209–#213), shell (#218–#239), hardening (#244–#277), MCP prompts and perspectives, mobile cards (2026-10-09), note repair (#391/#395), git credential scrub (#383/#394), study fixes #400, #405, #398, #402 (promoted in #407).
- **Architecture Traps**:
  - `prod` == `dev` needs Taha's explicit OK. PRs target `dev` directly, never stacked.
  - 1 container + 1 Postgres per customer. Control plane in separate private repo.
  - Collab is a person, no autosave PUT (CRDT is the note). Viewer read-only forever.
  - Exact seq scan for semantic edge recompute (#123). Mutation-verify every test.
  - MCP is Streamable HTTP only (`/mcp`, `/elara/mcp`); no stdio. Hosted at `chapters.piiix.org`; `elara.piiix.org` is not live.
- **Suite**: server + client Vitest suites run in CI (`checks`) on every PR. `server/test/mcp-secret-scan.test.ts` (#577) calls every MCP tool and prompt against seeded secrets: a new tool fails CI until it has a fixture step there. A `fix:` PR to `dev` also runs `fails-before` (#575): its changed tests must fail on the base commit, or the PR carries label `no-fails-before` + a `Fails-before: n/a because ...` line. Every PR to `dev` or `prod` runs `pr-evidence` (#579): the body needs an Evidence section with at least one link into the repo (template `.github/pull_request_template.md`), and claims need a link next to them; rules in `github-workflow.md`. `attribution` (#580, not required) fails a PR from a `fix/`, `ci/`, `docs/`, `feat/`, `chore/` or `test/` branch with a commit lacking a `Co-Authored-By:` trailer, unless it has label `human-only`. Bugs are filed as issues with the bug form (`.github/ISSUE_TEMPLATE/bug.yml`) and a `found-by:*` label (#581). The **Elara lab** (#576, `docs/agents/lab.md`) builds the commit with docker compose and runs the integration tests (collab relay, store, disk, MCP): fast tier on PRs to `dev` that change the image inputs (`server/**`, `client/**`, root manifests and lockfile, Dockerfile, compose) or `lab/**`; full tier nightly and on PRs to `prod`. Its gate fails on a failed or inconclusive check outside `lab/known-defects.json` or a listed defect that no longer shows; a fix removes its entry. Required status checks on `dev` and `prod` (#574): `checks`, `pr-evidence`, `fails-before`, `plan`, `lab`, `bench-gate`; `prod` also requires `review-verdict`, which passes only on an approving review of the head by another account with write permission or a `VERDICT: MERGE` comment (first line) posted after the latest push that names the head (`Head reviewed: <sha>`) and links the review record; the reviewer is a separate Opus session with an adversarial brief, not a different model (procedural, not an identity check). Promotions are fast-forward pushes of the reviewed head (`git push origin <sha>:prod`), so `prod` stays an ancestor of `dev` (`github-workflow.md`, Promotion to prod; Branch protection and the review gate).
- **Deferred**: cli-visualizer (#9, assigned), partial restore (#261), per-type notification prefs (#263).
- **Decided against (do NOT re-open)**: WebMCP browser standard (adr-001), Leiden (#265), graph DB (#268), GraphRAG (#267), cross-file calls (#266).
