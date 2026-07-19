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
- **Current task**: UI phase kicked off. Page-by-page structure was
  already speced (`2026-07-17-hosted-ui-structure-design.md`); its
  deferred visual-design pass is now done too —
  `2026-07-19-ui-design-system.md` (light-first "paper & ink,"
  dual-accent human/AI color system, ink-fade graph decay, Figma-pattern
  collab cursors on a curated ink palette, anti-slop tooling locked in:
  `impeccable`, `gsap-skills`, `frontend-design`, `design-taste-frontend`).
  Built via `/design-consultation`, approved by owner. Next: writing-plans
  skill to turn both specs into an implementation plan, then build
  `client/`.
- **Next step (UI phase)**: run writing-plans against the two UI specs,
  then build `client/` per `docs/agents/implementation.md`.
- **Known deferred** (all deliberate, documented, verified via a
  full-repo audit 2026-07-18): cloud storage/scheduled backups,
  cli-visualizer (#9, assigned), cross-file call-graph resolution,
  symbol-level embeddings, Leiden upgrade, partial/selective restore,
  anomaly detection for runaway AI edit loops, single-process
  architecture (see implementation.md).
- **Open issues**: #9 (deferred, assigned)
