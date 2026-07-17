# Chapters — Handling Protocols

How to handle files, context, failure, parallelism, testing, and tokens.
These are standing rules for every session and every agent.

## 1. Files & folders

- **Naming**: kebab-case for files and folders (`vault-shares.ts`,
  `handling-protocols.md`). TypeScript source: `.ts`/`.tsx`. Tests sit
  next to a config-declared root: `server/test/<module>.test.ts`
  mirroring `server/src/<module>/`. Spec docs:
  `YYYY-MM-DD-<topic>-design.md`. Plans: `YYYY-MM-DD-<sub-project>.md`.
- **Placement**: follow the structure map in `implementation.md` — a new
  file goes in the module folder it belongs to; if no folder fits, the
  structure map gets amended in the same PR, not silently.
- **One responsibility per file.** Small focused files beat large ones —
  cheaper to read (tokens) and safer to edit.
- **Never** commit secrets, `.env` files, `node_modules`, build output,
  or scratch files. Temporary work goes in the session scratchpad, not
  the repo.

## 2. Context handling

- Durable truth lives in the repo, not the conversation: specs (design),
  `STATE.md` (position), plans (task lists), code + tests (behavior).
- Session start or after context loss/compaction: re-read `brief.md` →
  `STATE.md` → the active plan's current task. Nothing else by default.
- If conversation memory and repo state disagree, **the repo wins** —
  reconstruct from `git log`, `git status`, `STATE.md`, and open PRs;
  never act on a remembered-but-unverified claim.
- When a decision is made mid-session that future sessions need, write it
  down (STATE.md, the plan, or a spec amendment) in the same PR.

## 3. Failure, interruption & resume (power outages are routine here)

- **Push early, push often.** Commit + push after every green test cycle;
  never leave more than ~15 minutes of work unpushed. `wip:` commits on a
  feature branch are fine — the PR title carries the real message.
- `STATE.md` is the resume anchor. Update it (and push) at every task
  boundary and before starting any long operation. It always answers:
  current phase, current task, next single step, open PR/issue numbers.
- **Resume protocol** after an interruption:
  1. `git fetch --all`, `git status` — find the branch and any dirty state.
  2. Read `STATE.md`, then the active plan's current task.
  3. Run the test suite to learn what state the code is actually in.
  4. Continue from the next unchecked step — never restart a task from
     scratch if pushed work exists.
- A half-done change that won't be finished this session: push it as
  `wip:` on its branch and record it in STATE.md. Never leave work only
  in the working tree.

## 4. Multi-agent / phases / tasks

- **Phases** = sub-projects (spec order, backend first). One phase in
  progress at a time; a phase isn't done until its spec's requirements
  all have green tests.
- **Tasks** come from the phase's plan file — each is one TDD cycle
  ending in a commit; one PR per task or small coherent group.
- **Subagents**: dispatch for (a) bulky read-only exploration that would
  bloat the main context, and (b) independent tasks touching disjoint
  files. Sequential by default; parallel only when tasks share no files.
  Parallel agents that edit files use isolated worktrees. Each agent gets
  a self-contained task description (files, interfaces, test command) —
  never "see conversation above."
- The main session is the orchestrator: it reviews every subagent diff
  before it lands and owns STATE.md and the PR flow.

## 5. Sandbox testing

- All tests run against ephemeral local resources only: Vitest + a
  throwaway Postgres (Docker Compose service on a random-named database),
  fresh schema per run, seeded fixtures, torn down after. Integration
  tests boot the real server on a random port.
- Tests never touch a deployed instance, real user data, or anything on
  `prod`. No test may depend on network access beyond localhost.
- Every non-trivial behavior gets a test in the same PR as the code —
  a branch, a permission rule, a parser, anything security-relevant.
  The suite must pass locally before any push and in CI before merge.

## 6. Visual testing (UI phase; API-phase equivalent now)

- **Backend phase (now)**: "visual" = observable. After implementing an
  endpoint/flow, exercise it end-to-end against the locally running
  server (curl/httpie or a small script) and confirm the actual response,
  not just unit tests.
- **UI phase (later)**: after each page lands, open it in the browser via
  the gstack `/browse` skill (never the Chrome-extension MCP tools —
  standing user rule): navigate the flow, screenshot key states, check
  the console for errors, verify interactions and animations actually
  run. A page isn't done until it's been looked at.

## 7. Token optimization

Goal: best output per million tokens. Standing rules:

- **Read narrow.** Grep/glob first, read only matching regions; read the
  active task, not the whole plan; one spec at a time. Never re-read a
  file the harness already has current.
- **Delegate bulk.** Big exploration/summarization goes to a subagent
  that returns a summary, keeping raw dumps out of the main context.
- **Write short-lived output nowhere, durable output in files.** Don't
  paste large code/diffs into PR bodies or chat; link or reference paths.
- **Batch independent tool calls** in one round-trip.
- **Keep STATE.md under ~40 lines** — it's read every session; its size
  is a recurring tax.
- **Small files, stable interfaces** (see §1) keep every future read
  cheap. Token efficiency is mostly an architecture property.
- Don't restate specs in plans or code comments — reference them.
