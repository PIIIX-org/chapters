# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: BACKEND COMPLETE → next is the UI phase
- **Done** (all on prod via dev):
  - Scaffold #16 | 1 Auth #18 | 2 Notes #21 | 3+4 Graph+Search #23 |
    5 Realtime #25 | 6 MCP #28 | 7 Export #30 | Admin dashboard #32 |
    MFA (this branch). 64 tests green across 13 suites.
  - Every spec implemented incl. all security-audit hardening; tracked
    deviations recorded in the plan docs (Louvain-not-Leiden, SSE
    read-only live view, collab on its own port).
- **Current task**: none in flight — backend done.
- **Next step (UI phase)**: design the page-by-page UI structure with
  the owner, then build `client/` (React+Vite+CM6+y-codemirror, Tailwind
  + shadcn via shadcn MCP, GSAP via magic MCP + docs, anime.js dep) per
  `docs/agents/implementation.md`. UI does NOT start until the owner
  approves the page structure.
- **Known deferred**: cloud storage/backups (unspecced), codebase
  exploration direction (needs brainstorming), cli-visualizer (#9,
  assigned @snavid-dev), Leiden upgrade, multi-process scaling notes
  (`ponytail:` comments mark them all).
- **Open issues**: #9 (deferred, assigned)
