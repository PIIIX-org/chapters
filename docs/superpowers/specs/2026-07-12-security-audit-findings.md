# Chapters — Security Audit Findings (2026-07-12)

A dedicated security and completeness audit run against all six sub-project
specs before any implementation began. This document is the source-of-truth
record of what was found; the fixes themselves were folded directly into
each affected spec under a "Security hardening (audit follow-up)" section.
Read this doc for *why* those sections exist; read the specs themselves for
the current design.

Findings are grouped by severity. Each entry names the affected spec(s), the
gap, a concrete failure scenario, and where the fix landed.

## Critical

1. **First-user-auto-admin race condition** — an attacker who reaches a
   fresh instance's `/signup` before its real owner does becomes permanent
   admin. *Resolved in: `2026-07-09-auth-vault-sharing-design.md`
   (Bootstrap section) — one-time deploy-time setup token replaces
   "first signup wins."*
2. **No account deactivation or vault-ownership transfer** — a departed
   employee's credentials, shares, and MCP connections stay live forever,
   with no way for anyone to reclaim a vault they solely owned. *Resolved
   in: `2026-07-09-auth-vault-sharing-design.md` (Account lifecycle
   section).*
3. **Vault-scoped MCP connections not explicitly blocked from
   account-wide operations** (merged graph, "search everywhere",
   list-all-vaults) — a token meant to be narrowly scoped could silently
   inherit account-wide reach if those operations aren't scope-checked.
   *Resolved in: `2026-07-12-mcp-integration-design.md` (Scope enforcement
   section).*
4. **OKF/frontmatter validation only guaranteed at the UI layer** — an MCP
   write could land with invalid frontmatter or a colliding path, since
   the only stated enforcement lived in a browser component the MCP path
   never touches. *Resolved in: `2026-07-09-editor-design.md` (Server-side
   OKF validation section).*
5. **Audit trail / revert history had no independent access control or
   purge** — a secret pasted and quickly deleted from a note remains
   readable (and revertible) by anyone with plain read access, for the
   entire retention window. *Resolved in:
   `2026-07-12-mcp-integration-design.md` (Audit/revert access control
   section).*

## High

6. **No password reset flow specified.** *Resolved in:
   `2026-07-09-auth-vault-sharing-design.md` (Password & session
   security).*
7. **No transport-security / session-cookie requirements stated
   anywhere** — a real risk for a self-hosted OSS project, whose typical
   deploy path is most likely to skip TLS. *Resolved in:
   `2026-07-09-auth-vault-sharing-design.md` (Password & session
   security).*
8. **No brute-force / credential-stuffing protection on login.**
   *Resolved in: `2026-07-09-auth-vault-sharing-design.md` (Password &
   session security).*
9. **Team ownership as an unreviewed privilege-escalation lever** — a
   team owner can add members who instantly inherit access to vaults the
   team was shared into, with zero notice to the vault owner who granted
   that share. *Resolved in: `2026-07-09-auth-vault-sharing-design.md`
   (Team-based sharing section).*
10. **Stale `VaultGraphPreference` not required to re-validate current
    access** — a revoked share could keep surfacing in a user's merged
    graph if the preference flag alone gated inclusion. *Resolved in:
    `2026-07-09-auth-vault-sharing-design.md` and
    `2026-07-09-graph-engine-design.md` (Merge preference / merge-time
    re-validation sections).*
11. **MCP token lifecycle entirely unspecified** — no stated entropy
    source, hashed storage, expiry, rotation, or revoke UI for a
    long-lived bearer credential. *Resolved in:
    `2026-07-09-auth-vault-sharing-design.md` (MCP connection token
    lifecycle section).*
12. **Prompt-injection / indirect instruction execution via note
    content unaddressed** — a poisoned note could manipulate an
    unrelated AI agent that later reads it via MCP into taking
    destructive or exfiltrating actions within its own legitimate
    permission scope. *Resolved in:
    `2026-07-12-mcp-integration-design.md` (Prompt-injection awareness
    section).*
13. **CRDT sync layer's per-operation permission enforcement was
    asserted, not designed** — a revoked editor's already-open socket
    could keep emitting valid edits until forcibly disconnected, if
    permission is only checked at handshake. *Resolved in:
    `2026-07-11-realtime-collaboration-design.md` (Per-operation
    permission enforcement section).*
14. **Presence broadcasts every collaborator's identity to all
    viewers**, including lower-permission ones with no relationship to
    the team involved. *Resolved in:
    `2026-07-11-realtime-collaboration-design.md` (Presence visibility
    section).*
15. **Rate limiting fully deferred** despite the design explicitly
    assuming multiple unsupervised concurrent AI agents — a single
    runaway agent could degrade the entire (single-org) shared instance.
    *Resolved in: `2026-07-12-mcp-integration-design.md` (Rate limiting
    section) — reclassified as structural, not deferred.*
16. **No data export / bulk backup / migration mechanism specified** —
    directly contradicts the README's "no proprietary database holding
    your notes hostage" promise. *Resolved in: `README.md` roadmap
    (added as a tracked future sub-project — see below).*
17. **No security-event logging/observability** for auth/access events
    (failed logins, permission-denied, admin approvals, token
    creation/use/revocation), despite the content audit trail being
    otherwise thorough. *Resolved in:
    `2026-07-09-auth-vault-sharing-design.md` (Security-event logging
    section).*

## Medium

18. **No on-demand hard-delete/purge**, only automatic trash retention —
    compounds finding 5. *Resolved alongside finding 5's fix.*
19. **No secrets-management / backup-restore guidance for
    self-hosters.** *Resolved in:
    `2026-07-09-auth-vault-sharing-design.md` (Deployment requirements
    section).*
20. **Revert not permission-scoped** — unclear who could invoke it.
    *Resolved alongside finding 5's fix (edit/owner only).*
21. **No anomaly detection / circuit breaker for runaway AI edit
    loops** beyond generic recoverability. *Partially addressed by the
    rate-limiting fix (finding 15); full anomaly detection remains
    future work, not respecced here.*
22. **No MFA/2FA mentioned, even as a roadmap note.** *Resolved in:
    `2026-07-09-auth-vault-sharing-design.md` (Password & session
    security — tracked as near-term follow-up, not built in v1).*
23. **Cascading deletes unaddressed** for team/account removal.
    *Resolved in: `2026-07-09-auth-vault-sharing-design.md` (Account
    lifecycle section).*
24. **No notification/activity-feed system** anywhere — no one is told
    when they're shared with, added to a team, or reverted. *Partially
    resolved: team-membership-change notifications landed in finding 9's
    fix; a general activity feed remains tracked as future work in the
    README, not fully respecced.*

## Low

25. **Terminology ambiguity**: "account" used inconsistently for
    "user" vs. implied org/tenant. *Resolved in:
    `2026-07-09-auth-vault-sharing-design.md` (Terminology clarification
    section).*
26. **Open team creation as a social-engineering surface** — reinforces
    an assumption the original spec already flagged for revisiting.
    *Reinforced in: `2026-07-09-auth-vault-sharing-design.md` (Team-based
    sharing section); still an open assumption, not fully closed.*
27. **Note name/type collision on type-first creation unaddressed.**
    *Resolved in: `2026-07-09-editor-design.md` (Server-side OKF
    validation section).*

## Missing functionality (tracked, not respecced here)

These are real capability gaps, not hardening items. Fully speccing each
would need its own brainstorming pass; for now they're tracked explicitly
in the README roadmap so they aren't silently absent:

- **Data export / vault backup / migration** (finding 16) — directly
  ties to the README's data-portability promise.
- **Notifications / activity feed** (finding 24, partially).
- **Admin oversight dashboard** beyond the approval queue (vault counts,
  storage usage, activity).
- **MFA** as a built feature (currently just a tracked intent).

## What the specs already got right

Noted briefly, since the bulk of this audit is intentionally the gap list:

- MCP's "no caching layer may span connections or accounts" was already a
  hard constraint, not an aspiration.
- Owner-only re-sharing (editors can't re-share) already blocks the most
  obvious escalation path.
- `mergeable` defaulting off (private-by-default) was already the right
  default.
- Soft-delete-always + an audit trail, specifically motivated by
  unsupervised AI agents, was already a sound defensive default before
  this audit tightened its access control.
- AI writes already routed through the same CRDT engine as humans, with
  visible attributed presence — no silent AI edits, by design.
- "One search function, N callers" and "graph queries reuse the same
  engine" were already the right structural instinct — this audit mainly
  closed boundary cases (findings 3, 4, 10) rather than redesigning the
  approach.
