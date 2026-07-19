# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: BACKEND COMPLETE — hardened + documented
- **Done**: full backend (original 7 + admin/MFA + codebase mapping 8/9
  + backup restore). Pre-production hardening pass: verified the real
  ONNX embedding path live (`NODE_ENV=production`, had never actually
  run before), built+ran the real Dockerfile against real Postgres,
  `@fastify/helmet` + env-gated `@fastify/cors`, `.github/dependabot.yml`,
  single-process constraint consolidated into `implementation.md`.
  Then: fixed the Dependabot npm group (was bundling major+minor
  together, one breaking major sank the whole batch — now
  minor/patch only, majors get individual PRs), found+fixed a real
  latent bug (`tree-sitter-javascript` used but never declared as a
  dependency, only worked by accident via `tsx`'s `NODE_PATH`), and
  wrote `docs/agents/backend-reference.md` — full architecture, data
  model, every subsystem, security, testing/deployment, maintenance
  runbook. Details of both passes: `backend-reference.md` §11 and this
  file's git history. 130 tests green.
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
