# Elara (repo `chapters`) — agent entry point

The product is **Elara** (formerly Chapters); the repository and some code
identifiers keep the name `chapters`.

Operating docs live in `docs/agents/`. Read in this order, every session:

1. `docs/agents/brief.md` — what this project is
2. `docs/agents/STATE.md` — current position, phase progress, open issues and bugs (generated from GitHub)
3. `docs/agents/implementation.md` — stack, structure, hard performance rules
4. `docs/agents/handling-protocols.md` — files, context, resume, agents, testing, tokens
5. `docs/agents/github-workflow.md` — dev/prod branches, PR/issue/promotion cycle

PR bodies follow `.github/pull_request_template.md` (Problem, Change,
Evidence, Not covered); `gh pr create --body-file` does not load it, so
fill in a copy. Claims link their run or artifact; the `pr-evidence`
check enforces it (rules: `github-workflow.md`, CI, PR evidence). Every
agent commit ends with a `Co-Authored-By:` trailer, and a bug you find is
filed as an issue with repro steps and a `found-by:*` label
(`github-workflow.md`, change cycle and Issues). STATE.md's generated
block is refreshed by a workflow: run `node .github/scripts/state-md.mjs
--write` only in the PR that lands the bot's block or one that edits the
hand-written part of STATE.md, not in every fix PR.

`docs/agents/backend-reference.md` documents the server as built.
Design specs: `docs/superpowers/specs/` (historical intent; where a spec
and the code disagree, the code and `backend-reference.md` win).
Integration tests (collab relay, store, disk, MCP against a real
instance) are the lab: `docs/agents/lab.md`.

Current phase: **phase 3 of the 2026-10-14 AI-performance study fixes,
"the premise"** (fewer tokens, exact answers: response budgets, slim tool
list, code index, retrieval, located hits and ranged reads). Phases 1
(guardrails) and 2 (stop data loss) are on `prod`. See
`docs/agents/STATE.md` for the phase in progress and the open bugs, and
the Elara note `fixes/phase-3-kickoff` for the work order.
