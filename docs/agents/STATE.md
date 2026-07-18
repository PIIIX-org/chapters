# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Phase**: BACKEND COMPLETE — codebase mapping + backup restore shipped
- **Done**:
  - Original 7 sub-projects + admin dashboard + MFA (PRs #16-#34)
  - Sub-projects 8+9: repository ingestion + code graph/search/MCP
    (PRs #37/#39/#40/#41) — see prior entries for detail
  - **Backup restore** (this branch, plan
    `docs/superpowers/plans/2026-07-18-backup-restore.md`): closes a real
    gap found via a post-completion audit — `buildInstanceBackup()`
    (sub-project 7) had no restore counterpart despite the original plan
    calling for one. `pnpm restore-backup <zip>` CLI (deliberately not an
    HTTP endpoint — restoring over a live instance is not a button):
    refuses on a non-empty instance, restores every account-layer table
    inside one transaction with original IDs preserved, recreates notes
    via the same shared OKF write path as import, marks instance setup
    complete. 127 tests green; e2e verified with a genuine live
    round-trip (real backup from a live source instance → CLI restore
    onto a fresh throwaway database → server boot against the restored
    DB → login + vault ownership + note content all confirmed working).
- **Current task**: none in flight.
- **Next step (UI phase)**: design the page-by-page UI structure with
  the owner, then build `client/` per `docs/agents/implementation.md`.
- **Known deferred** (verified via full-repo audit 2026-07-18, all
  deliberate and documented — see relevant specs' "out of scope"
  sections): cloud storage integrations + scheduled backups,
  cli-visualizer (#9, assigned), cross-file call-graph resolution,
  symbol-level embeddings, Leiden upgrade, partial/selective restore,
  anomaly detection for runaway AI edit loops (flagged in the security
  audit, never given its own spec).
- **Open issues**: #9 (deferred, assigned)
