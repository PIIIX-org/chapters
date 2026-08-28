# Chapters — Multi-tenant Workspaces (hosted signup)

Design for the hosted product's tenancy model. Decided by the owner
2026-08-28, in response to hosted signup being blocked by the setup token.
No implementation here; a plan follows this doc.

## The problem

`chapters.piiix.org` returns `403 {"error":"instance setup is not complete"}`
on `POST /api/signup`. That is correct behaviour for the code as written:
`isSetupComplete()` gates public signup unconditionally
(`server/src/auth/routes.ts:95`), there is no hosted/self-hosted switch
anywhere in the server, and the hosted box runs the same image as any
self-hosted one.

The token itself is not the mistake — it closed critical finding #1 of the
2026-07-12 security audit ("first signup wins" lets whoever finds a fresh
instance's URL claim permanent admin). The mistake is that **one instance ==
one tenant** was never questioned for the hosted edition. Under that model
"let the signer-up be admin" is not a smaller version of the same idea; it
is the audit finding, with everyone's data in blast radius instead of one
org's.

So the fix is tenancy, not a flag that skips the token.

## Decision

A **workspace** is the tenant boundary. Hosted signup creates a workspace
and makes the signer-up its admin. Members join a workspace by invitation.
Workspaces cannot see each other.

Self-hosted keeps the setup token and the approval queue exactly as they
are, and runs as a single workspace. Nothing about the OSS edition's
security posture changes.

## The anchor: one column, not thirty

The instinct with multi-tenancy is `workspace_id` on every table. **This
schema does not need that**, and adding it would be thirty columns of
denormalised truth to keep in sync.

Every user-facing read in the server already funnels through a per-user
predicate:

| Surface | Predicate today |
|---|---|
| Vaults, search, graph | `listAccessibleVaults(userId)` (`vaults/permissions.ts:67`) |
| Teams | `teamMemberships.userId = me` (`vaults/team-routes.ts:97`) |
| Repositories | `repositories.ownerId` + `repositoryShares.userId` |
| Notifications, MCP, sessions, email tokens | `userId` / `recipientId` |

So tenancy needs exactly one anchor:

```
workspaces        id, name, created_at, require_mfa
users.workspaceId → workspaces.id   (not null)
```

Everything else derives. A note is in your workspace because its vault's
owner is; a team is because its members are. **This holds only while no
cross-workspace edge can be created**, which is the real work — see below.

`workspace_id` on vaults/notes/teams/repositories is deliberately NOT
added. Add it only if a query is ever found that must answer "everything in
workspace X" without going through a user, and the join proves too slow.

## What changes

### 1. The four guards (the load-bearing part)

Four endpoints can create an edge between two users. Each must reject a
counterparty from another workspace, with the same 4xx it already returns
for an unknown user — no enumeration across the boundary:

- `POST /vaults/:id/shares` (`vaults/routes.ts:98`)
- `POST /repositories/:id/shares` (`repositories/routes.ts:218`)
- `POST /teams/:id/members` (`vaults/team-routes.ts:184`)
- `POST /vaults/:id/transfer` (`vaults/routes.ts:229`)

One shared helper, called by all four — a per-caller guard in each route is
how one of them ends up missing it.

### 2. Admin becomes per-workspace

`users.role = 'admin'` stops meaning "admin of the box" and starts meaning
"admin of my workspace". The surfaces that read globally today:

- `auth/admin-routes.ts` — list users, approve, promote, deactivate.
  Add `users.workspaceId = me.workspaceId` to every one.
- `auth/admin-dashboard-routes.ts` — 13 unfiltered counts and lists
  (users, vaults, teams, notes, MCP connections, shares, security events,
  revisions). Each joins to a user or a vault owner already; each gains
  the same predicate.

This is the bulk of the diff and it is mechanical. It is also the part
where a miss is a data leak, so every one of the 13 gets a test that seeds
a second workspace and asserts absence.

### 3. `instance_state` splits

- `setupTokenHash` / `setupCompletedAt` stay instance-level. They are the
  self-hosted bootstrap and mean nothing to a hosted tenant.
- `requireMfa` moves to `workspaces.requireMfa`. It is a policy an org sets
  for its own people, not a property of the box.

### 4. Signup forks on one flag

`SIGNUP_MODE` (default `join`, hosted sets `workspace`):

- **`join`** — today's behaviour, unchanged. Setup token claims workspace #1
  and its admin; public signup creates a `pending_approval` member of that
  workspace; an admin approves.
- **`workspace`** — signup creates a workspace, the user is its admin, and
  goes straight to `active` on email verification. No approval queue: there
  is no one to approve you, and the race the audit closed does not exist
  because the workspace did not exist a moment ago.

Email verification is still required in both. It is the only thing standing
between a typo'd address and an unreachable account.

### 5. Invitations (new; hosted needs them, self-hosted gets them free)

There is no invite feature in the server today — `POST /teams/:id/members`
takes the `userId` of an already-active user, so a member can only be added
after they have independently signed up and been approved. That is
incoherent once signup creates a *new* workspace: there is no way in.

Reuse the existing machinery rather than adding a table:

- An admin invites an address. A `users` row is created in that workspace,
  `status: 'invited'`, no password hash.
- `emailTokens` gains a third purpose, `'invite'`, and the existing
  `createEmailToken` / `consumeEmailToken` pair carries it — including the
  supersede-on-reissue property already documented there.
- The invitee sets a password against the token and lands `active`,
  email already verified by the fact that the token reached them.
- Re-inviting reissues; the old link dies. Already how that table behaves.

`users.status` gains `'invited'`. Login rejects it exactly like
`pending_approval`, with the same generic message.

## What deliberately does not change

- The setup token, for self-hosted. It is still the right answer there.
- Billing, plans, seat limits, per-workspace quotas. Out of scope; the
  workspace row is where they will hang when they exist.
- One person, one workspace. `users.email` stays globally unique, so login
  stays a single lookup by address with no workspace hint, no subdomain, no
  picker. **This is the assumption most likely to be wrong later** — the
  day someone needs the same address in two workspaces, email uniqueness
  becomes per-workspace and every login path needs a workspace selector.
  Reversible, but not cheaply. Called out here so the decision is explicit
  rather than discovered.
- Cross-workspace sharing. A vault belongs to one workspace, full stop.

## Migration

The existing instances have one implicit workspace each:

1. Insert one `workspaces` row per instance, name from the instance.
2. Backfill `users.workspaceId` to it, then set NOT NULL.
3. Copy `instance_state.requireMfa` onto it.

`chapters.piiix.org` has no users at all (setup never completed), so it
starts clean. dev and prod carry their current data into workspace #1.

## Slices

1. Schema + migration + the workspace anchor. No behaviour change.
2. The four guards, with cross-workspace rejection tests.
3. Admin + dashboard scoping, with an absence test per query.
4. `SIGNUP_MODE=workspace` and the workspace-creating signup path.
5. Invitations end to end.
6. Deploy: set `SIGNUP_MODE=workspace` and SMTP on the VPS.

Slices 1-3 are safe on the current single-workspace deployments — they
change nothing observable until 4 turns the fork on.

## Open, needs an answer before slice 4

- **Workspace name at signup**: ask for it on the form, or derive from the
  email domain and let them rename in settings? Deriving is one less field
  on the highest-friction screen in the product.
- **Second signup from a known domain**: someone signs up with an address
  whose domain already has a workspace. Silently create a second workspace
  (correct, occasionally surprising) or tell them their org is already here
  and to ask for an invite (leaks that the org uses Chapters)?
