# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: BACKEND COMPLETE — pre-production hardening pass done
- **Done**: full backend (original 7 + admin/MFA + codebase mapping 8/9
  + backup restore). This branch, prompted by "anything else to be
  concerned about" — closed every concrete gap raised, not just docs:
  - **Verified live**: the real production embedding path (ONNX
    bge-small via Transformers.js, `NODE_ENV=production`) had never
    actually run all session — booted it for real, confirmed a cold
    model download (~54s) then genuine semantic search (query
    "spacecraft propulsion control" correctly matched a note about
    "rocket engine... thruster ignition" with almost no shared
    keywords — real vectors, not the fake bag-of-words test embedder).
  - **Dockerfile** (repo root) + `.env.example` (every env var in one
    place) — built and ran the real image against the real
    docker-compose Postgres, hit `/health` and `/api/setup` over real
    HTTP from the host. (Needed colima memory bumped 2GB→6GB; the
    native `onnxruntime-node` install OOM'd at 2GB — a real constraint
    worth knowing if CI/build infra is ever sized down.)
  - `@fastify/helmet` + conditional `@fastify/cors` (env-gated,
    disabled/same-origin-only by default) — tested.
  - `.github/dependabot.yml` (npm + actions, weekly).
  - Consolidated the single-process-architecture assumption (lockout,
    embedding/extraction queues, permission-event bus, MCP rate limit,
    repo polling scheduler are all in-process state) into one place in
    `docs/agents/implementation.md` instead of five scattered
    `ponytail:` comments — documented as a real constraint, not fixed
    (building distributed versions of all five would be premature
    scaling work with no current deployment need).
  - 129 tests green (2 new: security headers present, CORS off by
    default).
- **Current task**: none in flight.
- **Next step (UI phase)**: design the page-by-page UI structure with
  the owner, then build `client/` per `docs/agents/implementation.md`.
- **Known deferred** (all deliberate, documented, verified via a
  full-repo audit 2026-07-18): cloud storage/scheduled backups,
  cli-visualizer (#9, assigned), cross-file call-graph resolution,
  symbol-level embeddings, Leiden upgrade, partial/selective restore,
  anomaly detection for runaway AI edit loops, single-process
  architecture (see implementation.md).
- **Open issues**: #9 (deferred, assigned)
