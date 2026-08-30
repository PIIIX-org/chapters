# Chapters — UI Command Redesign

**Status:** owner-directed, 2026-08-30. Supersedes the visual direction of
`2026-07-19-ui-design-system.md` and the "no persistent left nav" rule of
`2026-07-17-hosted-ui-structure-design.md` for the OSS client. Everything
else in those specs — page inventory, flows, the authorship colour rule, the
content boundary, the a11y gate — stands.

**Owner's brief (verbatim):** "the UI and the UX for this sucks, the
navigations sucks, and the user flow is not top tier … rebuild the ui,
userflow and the ux, using the best practices … i want the vibe to be
command like … no weird overlaps and funky animations."

## What was actually wrong

Measured against the shipped client, not the specs:

1. **Chrome overlapped content.** `AppShell` painted the scope picker, email
   and Log out as `position:absolute` siblings *over* the page, and every
   page underneath had to dodge it by hand (`GraphCanvas.tsx:443-448`,
   `:482-484` pad their own controls to clear the band). Any page that forgot
   got covered.
2. **No stable navigation.** Only Home had chrome; every other page rolled a
   different `← Home` link. Team, Settings, Admin, a repository and a vault
   each had a different header, a different width and a different way back.
   The only global affordance was ⌘K, which nobody discovers unaided.
3. **No place for detail.** Graph controls, outline, physics and notices were
   all floated on the canvas; the note editor's rail, revision history and
   properties competed for the same column with no consistent home.
4. **The visual system was a paper metaphor on a graph product.** The owner
   has now decided the product's face is the graph and the command surface,
   not the page.

## Direction: "Control room"

The client is a **command console over a knowledge graph**. Dark, dense,
calm. Thin hairlines, one accent at a time, monospace for anything the
machine produced (paths, ids, timestamps, counts), sans for anything a
person reads. The inspiration set (thirteen stills, one clip — dark network
and geospatial consoles, ranked side lists, inspector panels, stat tiles,
status dots) shares exactly these traits, and none of them is decorated.

**Non-negotiables inherited from the design system:** colour means *who*
(human vs AI/MCP), never decoration; teal is never a person; every
destructive or outward action confirms inline with its consequence in plain
language; `vitest-axe` gates every component.

### Tokens

Dark is the default and the brand's face. Light is a first-class secondary
theme (same tokens, different values); the account menu and Settings ›
Appearance offer dark, light, or follow-the-OS.

| Role | Dark (default) | Light | Meaning |
|---|---|---|---|
| `background` | `#0B0E14` | `#F5F6F8` | canvas |
| `card` | `#12161E` | `#FFFFFF` | panels, editor, inspector |
| `popover` | `#161B24` | `#FFFFFF` | menus, palette |
| `secondary` | `#0F1218` | `#EEF0F4` | recessed chrome: rail, top bar |
| `muted` | `#1A202B` | `#E6E9EF` | hover / active fills |
| `border` | `#232A37` | `#D8DCE4` | hairlines |
| `input` | `#2A3140` | `#C9CFDA` | field borders |
| `foreground` | `#E3E7EF` | `#161A22` | primary text |
| `muted-foreground` | `#8A93A6` | `#5E6675` | secondary text |
| `faint` | `#5B6475` | `#8C94A4` | tertiary text, disabled |
| **`primary`** (human) | `#5B8DEF` | `#2F6FE0` | a person did this: links, cursors, primary buttons |
| **`accent`** (AI/MCP) | `#3FB8AE` | `#1F7770` | AI/MCP did this: inferred edges, MCP writes, the AI cursor |
| `success` | `#4CC38A` | `#1F7A4D` | |
| `warning` | `#E6B455` | `#9A6B10` | |
| `destructive` | `#F26D6D` | `#C63B3B` | |

All text roles clear WCAG AA on their canvas. Collaborator inks stay five
hues (vermillion, indigo, plum, ochre, forest) re-tuned to the dark canvas;
teal remains AI-only. `bg-accent` is still never a hover colour.

**Type.** Geist (variable) for UI, Geist Mono (variable) for machine text.
Both self-hosted through `@fontsource-variable`, so a self-hosted instance
works offline — the Google Fonts `<link>` goes. Scale: page title 20/28
semibold, section 14/20 medium, body 14/20, dense 13/18, eyebrow 11px mono
uppercase tracked 0.08em. No serif, no display face: the console does not
have headlines, it has labels.

**Space, radius, line.** 4px base (`0.25rem` steps), panel padding 12,
gutter 8, rail 52, top bar 44, context panel 264, inspector 320. Radius: 6
everywhere, 10 for floating surfaces (palette, menus). One border width,
one shadow (floating surfaces only). No gradients, no glass, no glow.

**Motion.** Opacity and transform only, `120ms ease-out` in, `100ms ease-in`
out; panels open and close without animation (width is layout, animating
it reflows the editor). `prefers-reduced-motion` disables everything. No
entrance animations on page load, no hover lifts, no shimmer.

### The shell (one, for every authenticated route)

```
┌────┬──────────────────────────────────────────────────────────────┐
│    │ top bar: breadcrumb · ⌘K command input · status · bell · me   │ 44
│rail├──────────────┬────────────────────────────────┬───────────────┤
│    │ context      │ content                        │ inspector     │
│ 52 │ 264 (toggle) │ (fluid, owns its own scroll)   │ 320 (toggle)  │
└────┴──────────────┴────────────────────────────────┴───────────────┘
```

- **CSS grid, never absolute.** The rail, top bar, context panel and
  inspector are grid tracks. Nothing floats over content; a page can only
  paint inside its own cell. This is the structural fix for "weird overlaps".
- **Rail** (left, always): Graph · Vaults · Repositories · Team · Admin
  (admins only) — then, pinned to the bottom, Settings. Icon + tooltip + `aria-label`; active item marked with a 2px
  primary bar and `aria-current="page"`. Keyboard: `g` then `g/v/r/t/a/s`
  jumps (chords are ignored while typing in an input or the editor).
- **Top bar**: breadcrumb (eyebrow of the area + the object's name, as
  links); a centred **command input** that *looks* like a search field and
  opens ⌘K on focus/click (the palette is the field); right side: live
  status pill when the page has one (collab, repo sync), the panel toggles,
  the bell, and the account menu (email, theme, log out).
- **Context panel**: the page's navigation — file tree, repo files, admin
  sections, settings sections, graph outline. Toggle `[` .
- **Inspector**: the page's detail — selected community / node, note
  properties · history · sharing, repo sync · webhooks · access · symbols.
  Toggle `]`. Empty inspector collapses to nothing (no empty column).
- Below 1024px the context panel and inspector become drawers over content
  (the one sanctioned overlay, modal, dismissable); below 768 the rail
  becomes a bottom bar. Desktop-first; the phone layout is functional, not
  polished.

Pages place content in the shell through two components, `<ContextPanel>`
and `<Inspector>`, that render into the shell's tracks. The page owns the
state; the shell owns the geometry.

### Navigation model

- **Every area is one click from the rail** and ≤2 from ⌘K. The hosted
  spec's "no persistent left nav" was designed around the Sky as a spatial
  home; the OSS edition has no Sky, so the rule left it with no navigation.
  Reversed for this edition, recorded below.
- **Index pages exist**: `/vaults` and `/repos` list what you can reach,
  with the create/connect action at the top. They are lists with a search
  box, not dashboards; Home stays the graph.
- **⌘K is the command line.** Groups in order: *Actions* (new note here,
  new vault, connect repository, toggle theme…), *Go to* (areas), *Vaults*,
  *Repositories*, *Results* (notes and code, hybrid search). Each row has an
  icon, a label, a mono hint (path or shortcut) and a `Kbd` where a
  shortcut exists. Recent destinations show before typing. The scope chips
  and filters stay.
- **Breadcrumb is the back button.** No page renders its own `← Home`.
- **Deep links unchanged**: `/`, `/vaults/:id`, `/vaults/:id/notes/*`,
  `/repos/:id/files/*`, `/team`, `/admin`, `/settings`, auth routes.

### Pages

- **Graph (Home).** Canvas fills the content cell. Context panel: outline —
  communities ranked by size, expand/collapse, filter chips. Inspector:
  what is under the cursor or expanded (community stats, member list with
  "open"), then collapsible *Filters* and *Physics*. On the canvas itself
  only three small things: colour-mode pills top-left, zoom controls
  bottom-right, capped/truncation notices bottom-left — all inside the
  cell. Stats strip under the top bar: vaults · notes · code files · edges
  · communities, mono numerals.
- **Vaults index.** Table: name · access · mergeable · notes · updated, row
  actions (open, settings, rename, trash), trash section, new-vault form.
- **Vault / note.** Context: file tree grouped by type with the new-note
  action pinned. Content: a 40px note bar (path in mono, live status pill,
  presence avatars, actions) above the editor; the property panel folds
  into the inspector's *Properties* tab. Inspector tabs: Properties ·
  History · Sharing (owner). Read-only users see the same layout locked.
- **Repositories index.** Table: name · method · last sync · files, connect
  at the top. **Repository.** Context: file list (mono, sorted). Content:
  code viewer with a 40px file bar (path, language, "open on GitHub").
  Inspector tabs: Sync · Webhook · Access · Symbols.
- **Team.** Content: constellation hero, then the roster table (aggregate
  stats only). Inspector: team management (create, add/remove) and vault
  reach.
- **Admin.** Context: the six sections. Content: stat tiles on Overview,
  tables elsewhere, one section mounted at a time (unchanged). Confirm
  actions unchanged.
- **Settings.** Context: Account · Security · Notifications · MCP · Data ·
  Appearance. Content: one section at a time. Under an MFA mandate only
  Security renders (unchanged rule). Appearance holds the theme switch.
- **Auth.** Centred 360px card on the canvas with a dotted-grid backdrop,
  wordmark, mono eyebrow, the steps indicator. Copy unchanged — the login
  error stays generic on purpose.
- **States.** One `PanelState` for loading / empty / error with a retry, one
  `Skeleton`. Every table paginates or virtualises past 200 rows.

### Component kit (`client/src/components/ui`)

Existing shadcn primitives keep their API; new pieces are small and
composable: `Panel` (eyebrow header + actions + body), `StatTile`, `Pill`
(with `StatusDot` variants live/idle/error/ai), `Kbd`, `Eyebrow`, `Tabs`,
`Tooltip`, `DropdownMenu`, `Table` styles, `EmptyState`, `Skeleton`,
`ScrollArea` (native scrollbars styled thin). Icons: lucide, 16px, stroke
1.75.

### Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-30 | Dark-first "control room" replaces light-first "paper & ink" | Owner's call. The product's face is the graph and the command surface; every reference the owner supplied is a dark console. |
| 2026-08-30 | Persistent icon rail + top bar on every authenticated route | The OSS edition has no Sky; ⌘K-only navigation left it with nothing discoverable. The hosted rule is not touched. |
| 2026-08-30 | Grid shell with context/inspector tracks; no absolute chrome | Structural fix for chrome-over-content; pages can no longer overlap the shell or each other. |
| 2026-08-30 | `/vaults` and `/repos` index pages | Rail items need destinations; lists, not dashboards. Home stays the graph. |
| 2026-08-30 | Geist + Geist Mono, self-hosted | Console typography; removes the runtime Google Fonts dependency for offline self-hosting. |
| 2026-08-30 | Motion limited to opacity/transform, ≤120ms, none on layout | "No funky animations." |
