# Chapters — Admin Oversight Dashboard

Structural design only — no implementation detail. Closes one of the
tracked "known gaps" from the README (the remaining one is MFA).

## Depends on

- Sub-project 1 (Auth & Vault/Sharing model): unifies several admin
  actions already specced there (signup approval, user deactivation,
  admin promotion, vault-ownership transfer) into one admin-facing area,
  and surfaces its security-event log.
- Sub-project 6 (MCP integration): surfaces the content audit trail, and
  extends admin capability to force-revoking any `MCPConnection`.

## Goals

- Give admins one place to see instance-wide state — user/vault/team
  counts, storage usage, activity — instead of only the signup-approval
  queue that exists today.
- Consolidate admin *actions* that are already specced elsewhere
  (approve, deactivate, promote, transfer ownership) into the same area,
  rather than leaving them scattered.
- Give admins a real incident-response lever (force-revoking a share or
  MCP connection) without ever granting a backdoor into vault content —
  the strict "no admin backdoor, no trusted bypass" principle already
  established firmly in sub-project 6's isolation rules is not weakened
  here, only extended consistently.

## Content visibility: metadata only, never content

This is the load-bearing rule for the entire spec. Admins see vault
names, note counts, storage size, member/share counts, `mergeable` flags,
and last-activity timestamps — **never the actual text of any note.**
Extending an exception here would directly contradict sub-project 6's
explicit stance that no code path, admin role, or caching layer may
bypass the permission model. This spec deliberately does not create that
exception; it only adds structural visibility and structural actions.

## Views

One unified admin area, covering:

- **Approval queue** *(existing)* — pending-approval users, with an
  approve action. Already specced in sub-project 1; this dashboard is
  simply where it now lives.
- **User management** — every user, with status and role visible. Actions:
  deactivate, promote to admin, reassign a vault's ownership (all already
  specced in sub-project 1's security hardening — this is their UI home).
- **Vault oversight** — every vault on the instance: name, owner, note
  count, storage size, member/share count, `mergeable` flag, last-activity
  timestamp. No content preview, under any circumstance.
- **Team oversight** — every team, with member counts.
- **Instance activity** — a single admin-facing view surfacing two things
  that already exist: sub-project 1's security-event log (failed logins,
  permission-denied responses, admin approvals/promotions, MCP token
  creation/use/revocation) and sub-project 6's content audit trail (who
  or what changed which note, when). No new logging mechanism is
  introduced by this spec — it only surfaces what's already recorded.
- **Aggregate stats** — user counts by status (pending/active/deactivated),
  total vault count, total team count, total storage used across the
  instance, count of currently-active MCP connections.

## Incident-response power: force-revoke

An admin can force-revoke any `VaultShare` or any `MCPConnection`
instance-wide, including ones they didn't create and aren't the owner of.

This is deliberately scoped as a **structural/access action, not a
content-read action** — revoking someone's ability to reach a vault (or
killing a live MCP connection) never requires reading what's inside that
vault. Without this, the only incident-response lever an admin would have
for, say, a compromised account, is deactivating the entire account —
much blunter than scoped revocation, and not always the right response
(e.g. a leaked MCP token on an otherwise-legitimate account should get
that one connection killed, not the whole account deactivated).

## Explicitly out of scope for this sub-project

- **Any content-reading capability for admins** — see "Content visibility"
  above; this is a hard boundary, not a deferred feature.
- **Editing a vault's content, structure, or a note's frontmatter on an
  admin's behalf** — force-revoke removes access; it does not grant the
  admin any write capability into the vault itself.
- **Configurable dashboard views, custom reports, or data export from the
  dashboard itself** — the dashboard surfaces existing data; building
  its own export/reporting layer is separate from (and would depend on)
  sub-project 7's data-export primitives if ever built.

## Assumptions carried forward (revisit if wrong)

- Storage size shown per vault/instance is a size-on-disk figure for the
  OKF markdown files themselves — exact measurement/aggregation approach
  is an implementation-time decision, not fixed here.
- Force-revoke actions taken by an admin are themselves recorded in the
  security-event log (consistent with sub-project 1's logging
  requirement covering "admin approvals/promotions" — force-revoke is the
  same category of admin action and should be logged the same way).
