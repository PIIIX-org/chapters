# STATE

Resume anchor. The block between the `state:generated` markers is rebuilt from GitHub (issues, milestones, promotions, runs on `dev`) by `.github/scripts/state-md.mjs`; the `state-md.yml` workflow pushes `bot/state-md` when `dev`'s block is stale. Run `node .github/scripts/state-md.mjs --write` only in the PR that lands the bot's block or one that edits the hand-written part, not in every fix PR (`github-workflow.md`, STATE.md). Don't edit inside the markers. Keep the hand-written part below short and update it when it changes.

<!-- state:generated:start -->
<!-- Built by .github/scripts/state-md.mjs from GitHub data (workflow .github/workflows/state-md.yml). Edits between these markers are overwritten. -->
- **Last promotion to `prod`**: #899 Promote: phase 2 step A (prod ← ae6ffb9: #720 client, ADR-003 S1/S2a-1/S4/S5) (merged 2026-10-22, `f3724d0`).
- **Checks on `dev`**: CI (latest push run) success; nightly lab (full tier) **failure**; bench-gate (all suites) success. History: [CI](https://github.com/PIIIX-org/chapters/actions/workflows/ci.yml?query=branch%3Adev), [lab](https://github.com/PIIIX-org/chapters/actions/workflows/elara-lab.yml?query=branch%3Adev+event%3Aschedule).
- **Phases** (milestones, closed of total): [Phase 0: owner actions](https://github.com/PIIIX-org/chapters/milestone/1) 4/6, [Phase 1: guardrails and security](https://github.com/PIIIX-org/chapters/milestone/2) 25/25, [Phase 2: stop data loss](https://github.com/PIIIX-org/chapters/milestone/3) 52/52, [Phase 3: the premise (fewer tokens, exact answers)](https://github.com/PIIIX-org/chapters/milestone/4) 0/74, [Phase 4: knowledge truth and memory](https://github.com/PIIIX-org/chapters/milestone/5) 0/35, [Phase 5: everything else](https://github.com/PIIIX-org/chapters/milestone/6) 0/47, [Phase 6: rendered views and data attachments](https://github.com/PIIIX-org/chapters/milestone/7) 1/6, [Phase 7: new capabilities](https://github.com/PIIIX-org/chapters/milestone/8) 0/8, [Phase 8: UI and UX](https://github.com/PIIIX-org/chapters/milestone/9) 0/46.
- **Open issues**: [232](https://github.com/PIIIX-org/chapters/issues): P0 39, P1 112, P2 66, no priority 15; `bug` 57, `security` 12, `decision` 2, `deferred` 3.
- **Owner actions** (label `owner`):
  - #589 [fix 192] Revoke the 5 GitHub tokens exposed before #383 (P0)
  - #664 Production deploys on the push to prod, before CI publishes the gated image (#590 is… (P1)
  - #636 Production uptime
- **In progress: [Phase 3: the premise (fewer tokens, exact answers)](https://github.com/PIIIX-org/chapters/milestone/4)** (74 open, owner actions excluded):
  - #413 [fix 10] Index every note heading section and every code symbol as a block with a stable… (P0)
  - #414 [fix 11] Search hits return {path#Lx-Ly, block id, heading path, approx tokens, snippet… (P0)
  - #415 [fix 12] Group hits by note, at most 3 passages per note (P0)
  - #416 [fix 13] One read call accepts several targets (line range, block id or heading path) and… (P0)
  - #417 [fix 14] read_file and read_note without a range return an outline with line spans, not… (P0)
  - #418 [fix 15] Never collapse newlines in stored text, so line addressing stays valid (P0)
  - #420 [fix 17] Every read, search, browse, graph and history tool takes budget_tokens (P0)
  - #421 [fix 18] Over budget: drop whole low-ranked items, then step down a ladder (P0)
  - #422 [fix 19] Every response ends with a truncated block: shown, total (fetch limit+1 to… (P0)
  - #423 [fix 20] Very large results become a pageable, greppable handle instead of inline text (P0)
  - #424 [fix 21] browse_repository: path prefix filter and cursor (P0)
  - #425 [fix 22] browse_vault: root listing must respect recursive:false; return path and title… (P0)
  - … and 62 more: https://github.com/PIIIX-org/chapters/milestone/4
- **Open bugs** (label `bug`):
  - #713 [ui] Landing page says "No notes" to a user with notes (P1)
  - #714 [ui] Floating top bar collides with page controls; status pill duplicated (DEF-02, DEF-08… (P1)
  - #715 [ui] Primary actions rest at 20 % opacity (P1)
  - #716 [ui] Session expiry is not handled (P1)
  - #721 [ui] Note load: blank while loading, one message for every error (P1)
  - #728 [ui] Enter after a search creates a vault (P1)
  - #729 [ui] Snippets show markup; mobile drops the title (P1)
  - #731 [ui] The default graph of a small vault is four unlabeled dots (P1)
  - #733 [ui] Vault card footer clips "Delete"; the delete confirmation is unreadable (P1)
  - #734 [ui] The irreversible action has the weaker guard (P1)
  - #739 [ui] Repository page double-offsets the content (P1)
  - #741 [ui] Token tables are unusable on desktop (P1)
  - … and 45 more: https://github.com/PIIIX-org/chapters/issues?q=is%3Aopen+label%3Abug
<!-- state:generated:end -->

- **Product**: **Elara**; the repo keeps the name `chapters`. Current work: the fixes from the Elara AI-performance study (Elara vault notes `audit/2026-10-14-ai-performance-study` and its round-2 follow-up), one GitHub issue per fix-list item, grouped by the `Phase N` milestones above; plan in the Chapters vault `fixes/index`, hand-off `fixes/handoff-phase-1`. Production (`chapters.piiix.org`) redeploys by itself on every push to `prod` (about 20 s after the push, before CI has run), not from the image #590 publishes after CI (#664, owner action). Until #664 is fixed, the only gate on production is that the push is refused unless every required check on that commit is green, so never push to `prod` by any other route. A promotion is a PR `dev`→`prod` with every required check green (full lab tier and bench on its head) and a `VERDICT: MERGE` comment from an independent review, then a fast-forward push of the reviewed head (`git push origin <sha>:prod`).
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
