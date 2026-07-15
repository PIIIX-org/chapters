# Chapters — Notifications & Activity Feed

Structural design only — no implementation detail. Closes one of the
tracked "known gaps" from the README (the other two remaining are the
admin oversight dashboard and MFA).

## Depends on

- Sub-project 1 (Auth & Vault/Sharing model): most triggers are events
  already defined there (vault sharing, team membership, signup approval).
  This spec also completes that spec's own security-hardening requirement
  — "vault owners are notified when a team's membership changes" — by
  giving it a general delivery mechanism rather than a one-off case.
- Sub-project 6 (MCP integration): the "note reverted" trigger fires from
  that spec's audit/revert capability, regardless of whether the revert
  was human- or AI/MCP-initiated.

## Goals

- Tell a user when something relevant to them happens, instead of relying
  on them noticing a change themselves.
- Reach a user even when they're not actively in the app (email), since
  some events matter before the user would ever see an in-app inbox — most
  concretely, signup approval, which happens before the user can log in at
  all.
- Keep this a self-contained delivery layer over already-defined events,
  not a new permission system — a notification's visibility is always
  scoped to its one recipient.

## Triggers

Five distinct events generate a notification:

1. **Vault shared with you / share revoked** — you gained or lost access
   to a vault.
2. **Added to / removed from a team** — a team owner changed your
   membership.
3. **A note you have access to was reverted** — per sub-project 6's
   audit/revert capability, regardless of whether the revert was
   initiated by a human or an AI/MCP connection.
4. **Signup approved / account status change** — your waitlisted signup
   was approved, or an admin changed your account status (e.g.
   deactivation, per sub-project 1's security hardening).
5. **Team-membership change affecting a vault owner's share** — already
   required by sub-project 1's hardening section ("vault owners... are
   notified of the change" when a team they've shared a vault with gains
   or loses members). This spec is what actually delivers that
   requirement; sub-project 1 only established that it must happen.

## Data model

- **Notification** — recipient (one User), `type` (one of the five
  triggers above), a reference to the relevant entity (vault, note, or
  team, as applicable to the type), a human-readable snapshot of what
  happened (so the notification remains meaningful even if the referenced
  entity's name later changes), `created_at`, and read/unread state
  (`read_at`, nullable).

## Delivery

- **Every trigger produces both an in-app notification and an email** —
  one consistent rule across all five types, rather than special-casing
  which triggers get which channel. This keeps the delivery logic simple:
  one write path, two delivery side-effects, always.
- **In-app**: a notification bell/inbox, populated at load time. This is
  not live-pushed — no dependency on sub-project 5's real-time
  collaboration infrastructure. A user sees new notifications the next
  time they load the app or navigate, which is sufficient for this
  feature's urgency level (unlike live collaboration, where per-operation
  real-time delivery is safety-critical).
- **Email** is the only channel that reaches a user outside an active app
  session — necessary for signup approval specifically, since the
  recipient can't check an in-app inbox before they can log in. Sending
  it for every trigger type (rather than carving out signup approval as a
  special case) keeps the same "one write path, two side-effects" rule
  intact.

## Historical record vs. live content access

A notification is a historical record of an event, not a live view into
current state. If a vault is shared with a user and that share is later
revoked, the notification "vault X was shared with you on this date"
remains visible in the user's notification history — it is **not**
retroactively redacted or hidden.

This is a deliberate distinction from how the rest of the product treats
access: sub-project 1 requires every *content* access to be checked live,
with no cached or stale permission ever honored. A notification's
human-readable snapshot text is different — it records that an event
happened while the user did have legitimate access at that moment.
Knowing "a vault named X was once shared with me" is not the same
permission boundary as being able to read that vault's current content,
which remains strictly live-checked everywhere it actually matters
(editor, graph, search, MCP).

## Explicitly out of scope for this sub-project

- **Live/real-time push delivery** — deferred; load-time refresh is
  sufficient for v1, as established above.
- **Per-type notification preferences** (e.g. opting out of email for
  specific trigger types, digest/batching options) — every trigger gets
  both channels uniformly for now; per-type control is a v2 refinement,
  not designed here.
- **Push notifications to mobile/desktop OS-level notification centers** —
  not addressed; in-app + email only.

## Assumptions carried forward (revisit if wrong)

- No automatic expiry/retention limit on notification history — treated
  as a persistent activity feed, not an ephemeral toast queue. Exact
  retention policy (if any is ever needed) is an implementation-time
  decision.
- A notification's "human-readable snapshot" text is generated once at
  creation time and does not update if the referenced entity is later
  renamed — this is what makes the historical-record property in the
  section above meaningful (the notification reflects what was true when
  it fired, not a live-updating reference).
