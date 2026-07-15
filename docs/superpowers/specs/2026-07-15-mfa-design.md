# Chapters — Multi-Factor Authentication

Structural design only — no implementation detail. Closes the last
tracked "known gap" from the README.

## Depends on

- Sub-project 1 (Auth & Vault/Sharing model): extends the login flow and
  the signup/email-verification flow already specced there. Nothing here
  changes the permission/access-resolution model — MFA only strengthens
  how a session gets established in the first place.

## Goals

- Add a second factor to login, given the sensitivity of the data this
  platform holds (a company's whole knowledge base) — tracked as a
  near-term follow-up since sub-project 1's original spec.
- Keep it self-hosted-friendly: no third-party telephony provider, no
  per-message cost, no external dependency an OSS deployment has to pay
  for or configure just to turn MFA on.
- Let an org that decides MFA matters enforce it, without forcing every
  self-hosted deployment into it by default.

## Method: TOTP

Standard time-based one-time-password codes from an authenticator app
(Google Authenticator, 1Password, etc.). Chosen over the alternatives for
this project specifically:
- **Not SMS** — requires an external SMS provider (cost, dependency) and
  is the weakest option (SIM-swap attacks); a poor fit for a self-hosted
  OSS project with no external paid dependencies elsewhere in the design.
- **Not WebAuthn/passkeys (for now)** — stronger (phishing-resistant),
  but a bigger implementation surface and less universally available in
  users' existing setups than an authenticator app. Could be a future
  addition; not designed here.

## Signup email verification uses a code

This spec also specifies the mechanism for sub-project 1's already-planned
email verification step (added in that spec's security hardening): a code
is emailed at signup and entered to verify, rather than a magic link. This
is a clarification of *how* that existing requirement is fulfilled, not a
new requirement — email verification at signup is a separate concern from
ongoing-login MFA (a user isn't yet logged in or making an MFA choice at
that point; they're just proving they control the email address).

## Enforcement

- **Opt-in by default**: any active user can enable TOTP for their own
  account at any time, from their account settings.
- **Admin-mandatable**: an admin can flip an instance-wide setting
  requiring MFA for all active users. Once set, users without TOTP
  enabled are prompted to set it up before they can continue using the
  instance. This gives an org a real security lever without imposing it
  on every deployment by default — consistent with Chapters being
  self-hosted per-org (per the README), where different orgs have
  different risk tolerances.

## Recovery

When a user enables TOTP, they're shown a set of one-time backup codes at
that moment (shown once, same pattern as an MCP connection token). Each
backup code can be used exactly once, as a substitute for a TOTP code, to
recover account access if the authenticator device is lost. Without this,
a lost device would permanently lock a user out with no recovery path
short of admin intervention.

## Login flow

Every login challenges for the TOTP code (or a backup code) after
password verification succeeds — no "remember this device" exception.
Kept deliberately simple, consistent with MFA being the smallest and most
self-contained of the tracked gaps: every login is challenged, full stop,
rather than introducing device-trust state to manage.

## Explicitly out of scope for this sub-project

- **WebAuthn/passkeys** — a possible future addition, not designed here.
- **"Remember this device" / reduced-frequency challenges** — every login
  is challenged; no device-trust exception is part of this design.
- **Admin-initiated TOTP reset on a user's behalf** (e.g. if both the
  device and all backup codes are lost) — a real operational need
  eventually, but not designed here; for now this would fall under the
  existing admin deactivation/account-management actions from sub-project
  1 and the admin dashboard, without a dedicated MFA-reset flow.

## Assumptions carried forward (revisit if wrong)

- The exact number of backup codes issued and their format is an
  implementation-time decision.
- The instance-wide "require MFA" setting is a simple on/off toggle, not
  a more granular per-team or per-role requirement — if that granularity
  is ever needed, it's a revision to this spec, not assumed here.
