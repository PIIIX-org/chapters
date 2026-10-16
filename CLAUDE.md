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
(`github-workflow.md`, change cycle and Issues). Before finishing a fix
PR, run `node .github/scripts/state-md.mjs --write` and commit STATE.md if
it changed.

`docs/agents/backend-reference.md` documents the server as built.
Design specs: `docs/superpowers/specs/` (historical intent; where a spec
and the code disagree, the code and `backend-reference.md` win).
Integration tests (collab relay, store, disk, MCP against a real
instance) are the lab: `docs/agents/lab.md`.

Current phase: **reliability fixes from the 2026-10-14 AI-performance
study** (agent write path, crash safety, backup/restore, ingestion). The
backend and UI are built; see `docs/agents/STATE.md` for the phase in
progress and the open bugs.
