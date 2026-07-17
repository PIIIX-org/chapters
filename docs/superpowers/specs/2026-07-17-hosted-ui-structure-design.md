# Chapters — Hosted UI Structure (Page-by-Page)

Structural design for the hosted product's UI: pages, user flows between
them, and component placement. This is the "app chrome" that frames the
Yildizim galaxy layer (github.com/PIIIX-org/yildizim — working prototype
with all mechanics live: three zoom tiers, evolution/decay, supernova,
badges/stardust, by-user view, validated at 220 projects / 371k notes at
60fps). No implementation here; the UI phase builds from this doc.

**Open-core boundary, stated once:** self-hosted OSS Chapters gets every
page below EXCEPT the Yildizim sky and the achievements economy — its
Home is a plain 2D node-graph view (Graphify-style) of the same graph
API, and gamification surfaces are absent. Everything else (editor,
search, sharing, admin, auth, settings) is identical in both editions.

## Navigation model

- **The Sky is Home.** The hosted app opens into the full-bleed Yildizim
  view (opening flight per its spec). There is no dashboard-of-cards
  home page — the galaxy IS the overview.
- **Two spatial layers**: the Sky (3D, exploration/awareness) and Pages
  (2D chrome: editor, admin, settings...). One persistent affordance —
  a "Sky" button, bottom-left on every 2D page — returns to the galaxy
  exactly where you left it (camera state preserved per session).
- **⌘K is the universal seam.** The command palette works identically in
  both layers and is the primary way to jump anywhere (see Search).

## Pages

### 1. Sky (Home) — hosted only
Full-bleed Yildizim canvas. Chrome kept to the four corners, exactly as
prototyped:
- Top-left: wordmark, stardust balance.
- Top-right: info panel (hover/focus context), notifications bell,
  account menu.
- Bottom-center: badge earning toasts.
- Drawers: badge shelf (right), signature customization (left),
  people-view toggle (U), all prototyped.
The critical addition over the prototype: **the bridge to work** — see
Flow A below. Tier-3 planets (notes) become clickable: a focus card
(title, frontmatter summary, last edit, contributors) with "Open note" →
Editor page.

### 2. Editor
The workhorse page, per sub-project 2's spec:
- Left: vault file tree (OKF `type/name`), collapsible.
- Center: breadcrumb (project / vault / note — deliberately mirroring
  galaxy / star / planet), frontmatter property panel, CodeMirror 6
  live-preview body.
- Right rail (collapsible): backlinks ("linked mentions", from the graph
  engine), a 2D mini-map of the current vault's neighborhood, presence
  avatars when others are in the note (colors matching their live
  cursors, per sub-project 5).
- Autosave state whispers in the breadcrumb bar (never a modal).
- Read-only access renders the same layout locked, live-updating (SSE
  view per the collab implementation).

### 3. Search (overlay, not a page)
⌘K from anywhere:
- One input, hybrid results (path, snippet, frontmatter chips, score)
  from the one shared search function.
- Scope toggle: current vault / current project / everywhere.
- Filters: type, tags, date range.
- Beyond retrieval it's also the command surface: "fly to <project>",
  "open <vault>", "mark milestone…", "invite…" — actions and results in
  one list, actions prefixed distinctly.

### 4. Team
- The by-user constellation view (prototyped) embedded as the page hero.
- Below: roster list — per-person aggregate stats only (mass, projects
  touched, last activity; the privacy rule is absolute), team
  create/manage for team owners (add/remove members per sub-project 1).
- Vault owners see "who can reach this vault" expansion here (the
  team-share transparency requirement from the security hardening).

### 5. Vault settings (modal stack over any context)
Per-vault, owner-gated:
- Sharing: grantee picker (user/team), read/edit, revocation; live
  effect explained inline ("access is re-checked on every request").
- `mergeable` toggle with its plain-language consequence.
- MCP connections: create scoped (this vault), list with created/last
  used, one-click revoke (per sub-projects 1+6).
- Export: per-vault zip (notes + manifest), shareable expiring link
  (sub-project 7).

### 6. Admin
One area, per the admin-dashboard spec, metadata-only throughout:
approval queue, user management (deactivate/promote/transfer), vault
oversight table, team oversight, instance activity (security-event log +
audit trail surfaced), aggregate stats, force-revoke actions.

### 7. Achievements — hosted only
- Badge shelf expanded to a full page (tiers, earned states, rare kept
  "undiscovered").
- **Hall of Constellations**: the conquered-galaxies gallery — each
  black hole with its chosen signature, conquest date, contributors — the
  shareable artifact defined in the Yildizim design.
- Stardust ledger and signature inventory.

### 8. Auth
Signup → waitlist notice → (admin approval) → verification code → login
→ optional TOTP challenge → reset flow. All per sub-project 1's
hardened spec + MFA spec; deliberately plain, fast pages — the show
begins after login, at first flight.

### 9. Settings
Account (email/password/MFA enrollment with backup codes shown once),
notification preferences (in-app + email per the notifications spec),
account-wide MCP connections (same component as vault-scoped list),
data: full-account export requests.

## Key flows (the connective tissue)

- **Flow A — Sky to work and back** (the flow that makes the product):
  fly galaxy → star → planet → focus card → "Open note" → Editor, with a
  fly-out/fade transition carrying the planet's identity into the
  breadcrumb. "Sky" button returns to the same camera. Every other page
  is ≤2 clicks from anywhere via ⌘K.
- **Flow B — milestone**: project panel (Blue Giant) shows "Mark
  milestone…" → confirm dialog (explicit, per the deliberate-supernova
  rule) → supernova ceremony plays in the Sky → Hall of Constellations
  entry + Conqueror badge + stardust.
- **Flow C — decay intervention**: notification ("Beacon cools to Main
  Sequence in 3 days") → clicking lands in the Sky flown to that galaxy,
  panel showing the countdown → one click into its most recent vault to
  do the reviving work.
- **Flow D — AI visibility**: an MCP search/write in progress renders as
  the AI vessel/shuttle in the Sky (prototyped) and as a labeled
  presence in the Editor when it writes (per sub-project 6's
  same-collab-engine rule).
- Onboarding, sharing, search, collab flows: already diagrammed in
  `docs/superpowers/specs/diagrams/` 01–08; this spec adds no changes to
  them, only mounts them in pages.

## Component placement principles

- Chrome stays at the edges; the center belongs to content (Sky or
  note). No persistent left nav — the file tree appears only in Editor
  context; global movement is ⌘K + the Sky.
- Notifications: bell top-right everywhere; drawer feed; decay warnings
  and share/team events per the notifications spec.
- Presence: avatars only where presence is actionable (Editor top bar,
  note focus cards) — never a global "who's online" list (the people
  view carries ambient awareness instead, privacy-preserving).
- Every destructive/outward action (revoke, purge, milestone, export
  link) confirms inline with its consequence in plain language — the
  transparency rule from the research applies to UI copy, not just
  mechanics.

## Implementation notes for the UI phase

- Stack per the operating docs: React/Vite, CM6; components via shadcn;
  motion via GSAP + anime.js. The Yildizim canvas mounts as a component
  owning its own Three.js context (the prototype's modules port
  directly; its mock `data.ts` is replaced by the real APIs — projects/
  vaults/notes/activity from the backend, search/graph from their
  endpoints, live events from the collab layer).
- The prototype's `__yz` hooks become the component's public API
  (enter/exit/flyTo/celebrate/stats), consumed by ⌘K actions and Flow
  A/B/C handlers.

## Out of scope here

- Visual design tokens/theming for the 2D chrome (design-system pass at
  UI-phase start; the Yildizim prototype's editorial voice — warm
  off-whites on deep space, tracked uppercase eyebrows — is the seed).
- Mobile layouts (desktop-first; mobile is a later pass).
- Multiplayer presence in the Sky itself (deferred with Yildizim v2).
