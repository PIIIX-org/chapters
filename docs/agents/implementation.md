# Chapters — Implementation Prompt

This is the operating prompt for Claude Code (and any coding agent)
working in this repository. Follow it every session.

## Session start (read order)

1. `docs/agents/brief.md` — what this project is.
2. `docs/agents/STATE.md` — where we are, what's next.
3. The spec for the sub-project currently in progress (per STATE.md) —
   only that spec, not all of them.
4. `docs/agents/handling-protocols.md` and
   `docs/agents/github-workflow.md` — how to work.

## Tech stack (decided, not open for relitigating)

Full decision + rationale: `docs/superpowers/specs/2026-07-17-tech-stack-decision.md`.

- **Language**: TypeScript everywhere (strict mode). Node.js current LTS.
- **Server**: Fastify (HTTP API) + Hocuspocus (Yjs sync relay), one process.
- **Database**: PostgreSQL — accounts, shares, sessions, audit/security
  logs, notifications, search + embedding indexes (pgvector, Postgres FTS).
- **Note storage**: plain OKF markdown files on disk. The DB never holds
  canonical note content.
- **Embeddings**: local ONNX via Transformers.js (`bge-small-en-v1.5`
  default). Note content never leaves the instance.
- **Graph analysis**: graphology (Louvain now, Leiden tracked as upgrade).
- **MCP**: official MCP TypeScript SDK.
- **Frontend (UI phase, later)**: React + Vite, CodeMirror 6 +
  y-codemirror.next, Tailwind CSS + **shadcn/ui** (fetched via the shadcn
  MCP server), **GSAP** (via the 21st.dev "magic" MCP for
  inspiration/refinement + official docs) and **anime.js** (installed as a
  client dependency) for motion.
- **Tooling**: pnpm workspaces, Vitest, ESLint + Prettier, Docker Compose
  (app + Postgres), GitHub Actions CI.

## Project structure

```
chapters/
├── CLAUDE.md                  # thin pointer to docs/agents/
├── README.md                  # public entry point — keep current
├── docs/
│   ├── agents/                # operating docs (this folder) + STATE.md
│   └── superpowers/
│       ├── plans/             # one implementation plan per sub-project
│       └── specs/             # design specs — source of truth
├── package.json               # pnpm workspace root
├── docker-compose.yml         # Postgres for dev/test; app image later
├── server/                    # Fastify + Hocuspocus + MCP
│   └── src/
│       ├── app.ts             # server assembly (register plugins/routes)
│       ├── index.ts           # entry point
│       ├── db/                # schema, migrations, query modules
│       ├── auth/              # sessions, signup/approval, passwords
│       ├── vaults/            # vaults, shares, teams, permissions
│       ├── notes/             # OKF file storage + validation (later)
│       ├── search/            # FTS + embeddings (later)
│       ├── graph/             # edges + communities (later)
│       ├── sync/              # Hocuspocus relay (later)
│       └── mcp/               # MCP server (later)
├── shared/                    # types shared server ↔ client
└── client/                    # React + Vite (UI phase — do not start yet)
```

Rules: one responsibility per file; files that change together live
together; `shared/` holds only types/constants both sides need — no logic
dumping ground.

## Performance rules (hard-coded — every task inherits these)

1. **Every DB query is index-backed.** No sequential scans on hot paths;
   no N+1 — batch or join. New query → check the plan if in doubt.
2. **Nothing slow sits on a request path.** Embedding computation, graph
   recomputes, email sends run async (queued/deferred) — a note save or
   API call never waits on them.
3. **Every list endpoint paginates.** No unbounded reads, ever.
4. **Budgets** (dev hardware, 10k-note vault): CRUD API p95 < 100ms,
   search < 500ms, save-to-visible sync latency < 250ms. A change that
   blows a budget is a bug, not a trade-off.
5. **Permission checks are single indexed queries** — live-checked per
   request per the specs, never cached across connections (sub-project
   6's hard rule), so they must be cheap by construction.
6. **UI phase**: initial bundle < 300KB gzipped; animations
   (GSAP/anime.js) animate `transform`/`opacity` only — compositor-
   friendly, 60fps; heavy views (graph) lazy-load.
7. **No speculative optimization beyond these rules.** Meet the budgets,
   measure before optimizing further.

## Phase discipline

- **Now: backend only**, sub-projects 1 → 7 in spec order. No `client/`
  code, no UI dependencies installed until the backend is done and the
  page-by-page UI structure has been designed and approved.
- Each sub-project: write its plan to `docs/superpowers/plans/` first,
  then implement task by task (TDD — failing test, minimal code, green,
  commit) per `handling-protocols.md`.
- Definition of done for any task: tests green locally, pushed, PR
  merged per `github-workflow.md`, README + STATE.md updated if the
  change is meaningful.

## Deployment topology: single process only (important, read before scaling)

This entire backend assumes exactly one running instance. Five
subsystems hold state in process memory, not in Postgres or any shared
store — none of them are broken for a single instance (the intended
deployment target), but **every one of them silently misbehaves the
moment a second instance runs against the same database**, whether
that's for horizontal scale or just redundancy:

- `auth/lockout.ts` — brute-force lockout counters (per-process; a
  second instance has its own counter, so the shared lockout threshold
  is effectively multiplied by instance count).
- `search/embedding-queue.ts` / `repositories/extraction-queue.ts` —
  in-process serial queues (work scheduled on one instance never runs
  on another; no risk of double-processing, but no load distribution
  either).
- `sync/permission-events.ts` — the live permission-change event bus
  driving instant collab/SSE kicks on revocation. An instance that
  didn't receive the in-process event never kicks its own connections
  — a revoked user could keep a live session open on a different
  instance than the one that processed the revocation.
- `mcp/rate-limit.ts` — per-connection rate buckets (per-process; a
  client can get up to N× the intended limit by having requests land
  across N instances behind a load balancer).
- `repositories/scheduler.ts` — the git polling fallback (multiple
  instances would each independently poll and clone the same
  repositories on their own schedules).

**Upgrade path, if this is ever needed**: Postgres `LISTEN`/`NOTIFY` or
Redis pub/sub for the permission-event bus; a `jobs` table or a real
queue (BullMQ, etc.) for the embedding/extraction queues and the
polling scheduler (with a claim/lock column so only one instance picks
up a given job); the lockout and rate-limit counters move to Postgres
or Redis with atomic increment. None of this is built — don't assume
it exists. Each site above already carries its own `ponytail:` comment
naming this same upgrade path; this section exists so the constraint is
visible in one place instead of five.
