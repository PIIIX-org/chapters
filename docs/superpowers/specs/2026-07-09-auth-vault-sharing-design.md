# Chapters — Auth & Vault/Sharing Model

Sub-project 1 of 6. Structural design only — no implementation detail.

## Product context

Chapters is a self-hostable, open-source "second brain" web app. One deployment serves one
organization (company); the code itself is open source so anyone can run their
own instance. Replaces Obsidian entirely — the web app is the only editor, on
every device, with a single source of truth on the server (no local vault
sync).

Notes are plain markdown + YAML frontmatter, following the **OKF** spec
(`type`, `resource`, `tags`, `timestamp` frontmatter; `type/name` path
convention; relationships as markdown links; auto-generated `index.md` per
folder). The graph engine borrows **Graphify's** relationship model
(`EXTRACTED` vs `INFERRED` edges, Leiden community detection) to power
clustering, filtering, and AI-queryable search.

## Sub-projects and build order

1. **Auth & Vault/Sharing model** (this spec) — accounts, vaults, permissions.
   Everything else depends on this.
2. **Editor** — live-preview markdown editor (Obsidian-style), single-user
   save/load against a vault.
3. **Graph engine & view** — per-vault graph, OKF/Graphify-inspired, with
   type/tag clustering, filtering, physics/cosmetic controls, opt-in
   cross-vault merge.
4. **Full-text search** — core v1 feature, shared index for both the human
   search UI and MCP queries; tuned for AI recall (must not miss relevant
   notes) without sacrificing speed.
5. **Real-time collaborative editing** — CRDT-based (e.g. Yjs) live
   multi-user editing, layered onto the editor once single-user editing is
   solid.
6. **MCP integration** — per-user, scoped MCP connections (account-wide or
   single-vault), exposing read/write/search through the same permission
   model as the UI.

## This spec: Auth & Vault/Sharing model

### Goals

- Let users sign up, get approved, and log in.
- Let users create any number of vaults and own them.
- Let vault owners share a vault with an individual user or a team, at
  read or edit permission.
- Let users control whether a vault they can access shows up in their own
  merged cross-vault graph, gated by the vault owner's global setting.
- Let users generate scoped MCP connections (account-wide or single-vault)
  whose access always reflects live permissions.

### Entities

- **User** — email, password hash, `status` (`pending_approval` | `active`),
  `role` (`member` | `admin`). The first user ever created on an instance is
  automatically `active` and `admin` (bootstraps a fresh instance without
  requiring config-file setup). Admins approve pending users and can promote
  other admins.
- **Team** — name. Has an owner (its creator), who manages membership.
- **TeamMembership** — links User ↔ Team with a role (`owner` | `member`).
  Owners add/remove members; members simply inherit whatever access the
  team's vault shares grant.
- **Vault** — owned by one User. Has a name and a `mergeable` flag (owner
  controlled; default **off**). This flag is a global gate: if off, no one
  can merge this vault into their own cross-vault graph, regardless of their
  personal preference.
- **VaultShare** — (vault, grantee, permission). Grantee is either a User or
  a Team. Permission is `read` or `edit`. Only the vault **owner** can
  create or revoke shares — editors cannot re-share, preventing accidental
  permission escalation.
- **VaultGraphPreference** — per (User, Vault): "include this vault in my
  merged graph." Effective only if the vault's `mergeable` flag is on. Lets
  a personal viewing preference sit independently on top of the owner's
  global gate, since different people with access to the same vault may
  want different merge behavior.
- **MCPConnection** — owned by one User. `scope` is `account` or `vault`
  (with `vault_id` required when scope is `vault`). Account-scope resolves
  live to whatever vaults that user currently has access to; vault-scope is
  pinned to one vault. Both are checked against **current** permissions on
  every request — revoking a share or flipping `mergeable` takes effect
  immediately without touching any issued connection/token.

### Access resolution rule

A user can reach a vault if any of the following hold:
- they own it, or
- there is a direct `VaultShare` to them, or
- there is a `VaultShare` to a team they belong to.

Effective permission is the highest permission across all matching grants.

### Key flows

1. **Signup → approval**: user registers with email + password →
   `pending_approval` → appears in the admin approval queue → an admin
   approves → `active`, can log in. The first user on a fresh instance
   skips this (auto-admin, auto-active).
2. **Login**: email + password → session.
3. **Vault creation**: any active user creates a vault and becomes its
   owner; `mergeable` starts off.
4. **Sharing**: the vault owner picks a grantee (specific user or team) and
   a permission level (read/edit). Only the owner manages shares.
5. **Team management**: a user creates a team (becomes its owner), and
   adds/removes members. Any vault owner can share a vault to a team
   whether or not they themselves belong to it.
6. **Merge opt-in**: for any vault a user can access, they may toggle
   "include in my merged graph" — effective only if the vault's `mergeable`
   gate is on.
7. **MCP connection**: user generates a connection (account-wide or
   vault-pinned) and receives a token. Every call through it is
   permission-checked live against current access, not a snapshot taken at
   creation time.

### Explicitly out of scope for this sub-project

- Editor, graph rendering, search, and real-time collaboration are separate
  sub-projects (2–6 above) and build on top of this data/permission model,
  not part of it.
- Binary attachments — notes are markdown-only (decided for the whole
  product, not just this sub-project).
- Multi-organization / cross-company tenancy or billing — one deployment
  serves one organization; the open-source code itself is what enables
  other organizations to self-host separately.
- Fine-grained team roles beyond owner/member (e.g. per-team custom roles) —
  can be added later if flat ownership proves insufficient.
- A cap on the number of MCP connections a user may generate — unlimited
  for v1.

### Assumptions carried forward (revisit if wrong)

- Vault `mergeable` defaults to **off** (private-by-default is the safer
  assumption for a company knowledge base).
- Sharing is always vault-owner-initiated; there is no request-access flow
  in this sub-project.
- Team creation is open to any active user, not admin-gated.
