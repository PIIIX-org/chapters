# Elara (repo `chapters`) — agent entry point

The product is **Elara** (formerly Chapters); the repository and some code
identifiers keep the name `chapters`.

Operating docs live in `docs/agents/`. Read in this order, every session:

1. `docs/agents/brief.md` — what this project is
2. `docs/agents/STATE.md` — current position, open issues, known defects
3. `docs/agents/implementation.md` — stack, structure, hard performance rules
4. `docs/agents/handling-protocols.md` — files, context, resume, agents, testing, tokens
5. `docs/agents/github-workflow.md` — dev/prod branches, PR/issue/promotion cycle

PR bodies follow `.github/pull_request_template.md` (Problem, Change,
Evidence, Not covered); `gh pr create --body-file` does not load it, so
fill in a copy. Claims link their run or artifact; the `pr-evidence`
check enforces it (rules: `github-workflow.md`, CI, PR evidence).

`docs/agents/backend-reference.md` documents the server as built.
Design specs: `docs/superpowers/specs/` (historical intent; where a spec
and the code disagree, the code and `backend-reference.md` win).

Current phase: **reliability fixes from the 2026-10-14 AI-performance
study** (agent write path, crash safety, backup/restore, ingestion). The
backend and UI are built; see `docs/agents/STATE.md` for the ordered list
of open defects.
