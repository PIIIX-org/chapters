# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: UI PHASE — Slice 1 (Scaffold + Auth) complete; Slice 2
  (Editor) next.
- **Done**: full backend, hardened + documented (130 tests; real ONNX
  embeddings, real Dockerfile/Postgres, helmet+cors, Dependabot; see
  `backend-reference.md` for full architecture/security/runbook — details
  of the hardening pass live there and in this file's git history).
  Slice 1 of the UI (`client/`, Tasks 1-13): Vite+React+TS scaffold,
  Tailwind design system (paper & ink palette, `.dark` mode), shadcn
  primitives (Button/Input/Label/Card), typed API client + auth
  functions, TanStack Query session hook, react-router + `RequireAuth`
  guard, every auth page (Setup, Signup, VerifyEmail, Login with inline
  MFA, password reset request/confirm, logout). React-aware ESLint
  (`eslint-plugin-react-hooks`/`-react-refresh`) now wired for
  `client/**`. Full root verification green: lint, typecheck, 35 client +
  130 server tests, `client` production build.
- **Current task**: none — Slice 1 done and verified end to end.
- **Next step**: Slice 2 (Editor) — live-preview markdown editing with
  CodeMirror 6, OKF-compliant by construction. No spec/plan written yet;
  run writing-plans against the Editor sub-project design first.
- **Known deferred** (all deliberate, documented, verified via a
  full-repo audit 2026-07-18): cloud storage/scheduled backups,
  cli-visualizer (#9, assigned), cross-file call-graph resolution,
  symbol-level embeddings, Leiden upgrade, partial/selective restore,
  anomaly detection for runaway AI edit loops, single-process
  architecture (see implementation.md). MFA *enrollment* UI is Settings-
  page work for a later slice, not built yet (Global Constraints).
- **Open issues**: #9 (deferred, assigned)
