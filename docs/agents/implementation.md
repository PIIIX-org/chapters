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
- **Graph analysis**: graphology (Louvain). Leiden was evaluated and
  **decided against** (2026-08-22): its guarantee is that Louvain can emit
  disconnected communities, which only matters when a community is fed to a
  summarizer. We never summarize communities — the result is one integer the
  client colours nodes by. See
  `docs/superpowers/plans/2026-08-22-graph-engineering-findings.md`.
- **MCP**: official MCP TypeScript SDK.
- **Frontend**: React + Vite, CodeMirror 6 +
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

### Measured: `buildGraph()` (2026-08-22, issue #93)

`pnpm profile-graph <n>` — synthetic notes, dev hardware (colima, pg17),
`SEMANTIC_K=8`. Times in ms.

| phase                     |  1k  |  5k  | 10k  |
|---------------------------|-----:|-----:|-----:|
| **`buildGraph()` total**  | 58.1 | 254.8| 499.8|
| graphology build          | 20.8 | 91.3 | 198.3|
| pairwise structural loops |  7.3 | 26.3 | 114.7|
| query: semantic_edges     | 10.6 | 51.5 | 111.5|
| loop: semantic            |  3.3 | 15.5 |  30.7|
| query: note_links         |  7.4 | 15.7 |  29.4|
| **louvain**               |  2.8 | 15.2 |  25.6|
| query: notes              |  3.7 |  8.1 |  12.1|

Edges at 10k: 285k total (195k structural, 80k semantic, 10k extracted).

**Louvain is not the bottleneck — it is ~5% of the call.** The issue
suspected it because it is the most algorithmic-looking line; the cost is
actually building the graphology structure (~40%), the O(n²)-within-group
pairwise structural edges (~23%), and the `semantic_edges` query (~22%).
Caching Louvain alone would buy ~5%. Cold and warm runs are within noise of
each other (499.8 vs 480.0 at 10k), so this is CPU-bound in JS, not I/O.

If `buildGraph()` ever needs to be faster, the target is the 195k structural
edges — they are decoration derived from type/tag/language grouping, not
stored data — or caching the whole assembled graph. Not Louvain.

At 10k notes this sits at ~500ms, which is within the search budget above but
is the slowest read path in the app. It is not currently on any user's
critical path at that size.

## Product shape (decided 2026-08-27 — read before proposing a fork)

Chapters ships two ways and **is not forked to do it**:

- **Self-hosted OSS** — someone runs the image themselves.
- **Hosted** — one container and its own Postgres **per customer**, fully
  separated, provisioned by a control plane.

`2026-07-17-hosted-ui-structure-design.md` states the editions are identical
except the Yildizim sky and achievements, and those live in their own private
repo. So: **one repo, one branch line** (`dev` → `prod`), hosted-only layers
stay in their own repos, and the **control plane** — provisioning, billing,
routing, fleet updates — is a separate private repo.

**The control plane sits above the app and the app must never know it exists.**
Yildizim is a layer the app consumes; the control plane operates instances. If
anything in `server/` or `client/` ever imports or calls it, self-hosting is
dead and there are two products again.

There is deliberately **no edition flag**: it would branch on nothing, since
the only hosted-only surfaces are not in this repo. Add one when something
actually differs.

## Phase discipline

- **Now: the deployable phase** — see
  `docs/superpowers/plans/2026-08-27-deployable.md`. The UI phase is complete
  (7 units, all merged); the product still cannot be run by anyone.
- Each sub-project: write its plan to `docs/superpowers/plans/` first,
  then implement task by task (TDD — failing test, minimal code, green,
  commit) per `handling-protocols.md`.
- Definition of done for any task: tests green locally, pushed, PR
  merged per `github-workflow.md`, README + STATE.md updated if the
  change is meaningful.

## Deployment topology: one process per instance (this is now a feature)

This backend assumes exactly one running process per instance. That used to be
a documented limitation; under the hosted model decided on 2026-08-27 — one
container and one Postgres **per customer** — it is satisfied by construction,
and the upgrade path below is not needed for the hosted product. It still
matters for a self-hoster who tries to run two replicas.

Five subsystems hold state in process memory, not in Postgres or any shared
store. None are broken for a single instance (the intended deployment target),
but **every one silently misbehaves the moment a second instance runs against
the same database**, whether for horizontal scale or just redundancy:

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
