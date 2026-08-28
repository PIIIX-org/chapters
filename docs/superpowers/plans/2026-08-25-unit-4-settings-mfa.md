# Unit 4 — Settings and MFA

Implements the unit 4 section of
`docs/superpowers/specs/2026-08-22-remaining-ui-design.md` against
`docs/superpowers/specs/2026-07-15-mfa-design.md`.

## Locked by the MFA spec (do not relitigate)

TOTP only. No SMS, no WebAuthn, no "remember this device", no admin-initiated
reset. **Every login is challenged** once TOTP is on. Backup codes are shown
exactly once at enrollment, through the existing `SecretReveal`. An instance
admin can mandate MFA instance-wide; while that is on, nobody can disable their
own TOTP.

## Backend gaps (the spec's addition table lists none for this unit)

| # | Gap | Why it blocks the unit |
|---|---|---|
| 1 | `GET /me` omits `mfaEnabledAt` and the instance MFA requirement | Settings cannot show whether MFA is on, and cannot know to hide Disable |
| 2 | No change-password for a logged-in user | Only the emailed-token reset exists |
| 3 | No change-email | Spec names email under Account |
| 4 | `notify()` always emails, with no opt-out | Spec names notification preferences |
| 5 | No account-wide export | Only per-vault export exists |

## Notification preferences: scoped down, deliberately

`2026-07-15-notifications-activity-feed-design.md` puts **per-type preferences
and digest/batching explicitly out of scope** — "a v2 refinement, not designed
here". The UI spec's one-line mention of "notification preferences" assumed
something existed; nothing does — no column, no endpoint.

Building per-type control now would be designing a deferred feature mid-UI
phase. What ships instead is the one switch that is not deferred: a single
account-level "email me about notifications" toggle, honored in `notify()`.
In-app notifications are unaffected — they are the activity feed, and turning
those off would break the historical-record property the notifications spec
depends on. **Flag this to Taha in the PR**; per-type control stays a v2 item.

## Changing email re-verifies

Login requires `emailVerifiedAt` (`auth/routes.ts:169`). Changing the address
therefore clears it and mails a new code, which means the user is locked out
until they verify — so the confirm copy has to say that in plain language
before it happens, not after. A taken address is a 409, not a silent no-op.

## Tasks

1. **Backend** — the five gaps above, each with real-database tests.
2. **Client contract** — `api/account.ts` + `hooks/useAccount.ts` (written
   first; every section codes against it).
3. `AccountSection` — change email, change password, both with inline
   consequence copy.
4. `MfaSection` — enroll (secret + provisioning URI, verify code), backup
   codes once via `SecretReveal`, disable, and the instance-mandated state
   where Disable is not offered at all.
5. `NotificationPreferences` — the email toggle.
6. `McpPanel` — generalize `VaultMcpPanel` to take a scope so the account-wide
   list is the *same component*, per spec. The vault panel keeps working.
7. `AccountExport` — download every vault you own.
8. `SettingsPage` + `/settings` route + ⌘K entry.
9. Admin: the instance MFA-requirement toggle (`PUT /admin/mfa-requirement`
   shipped in unit 3 with no UI).
10. Enforcement: when the instance mandates MFA and the user has none, the
    shell sends them to enrollment before anything else.
11. README + STATE.md.

## Testing

Client: vitest + happy-dom, an axe assertion per new component, **every test
mutation-verified**. Server: real-database integration tests.

Unit 3's lesson stands: the client suite stubs `fetch`, so it cannot see a
transport bug. This unit gets a real browser pass against a running server
before it is called done.
