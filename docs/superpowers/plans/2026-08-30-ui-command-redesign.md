# Plan — UI command redesign

Spec: `docs/superpowers/specs/2026-08-30-ui-command-redesign.md`. Every
slice is one PR to `dev`, merged on green CI, in this order. Slices 2–7
touch disjoint files and can run in parallel once slice 1 is merged.

Definition of done for a slice: typecheck + lint + client suite green
(including `bundle.test.ts` and axe assertions), the affected pages
screenshotted against the mock API in both themes, no element painted
outside its grid cell, README/STATE touched if the change is meaningful.

## 0. Mock API for visual QA (dev tooling)
- [ ] `client/mock/server.mjs`: fixture-backed HTTP server for every
      `/api/*` path the client calls (`client/src/api/*`), plus the
      `/collab/ticket` shape; `pnpm --filter @chapters/client dev:mock`
      starts vite with the proxy pointed at it. No Postgres needed.
- [ ] `client/mock/README.md`: what it fakes, what it cannot (yjs relay,
      SSE) — the editor renders in "offline" status against it.

## 1. Foundation: tokens, kit, shell, routes
- [ ] `index.css`: new token set (dark default, light secondary),
      `@fontsource-variable/geist` + `geist-mono`, remove Google Fonts.
- [ ] `lib/theme.ts` + `hooks/useTheme.ts`: `dark | light | system`,
      persisted, applied as the `.dark` class on `<html>` (keeps every
      existing `.dark` reader working).
- [ ] `components/ui`: `Panel`, `StatTile`, `Pill`/`StatusDot`, `Kbd`,
      `Eyebrow`, `Tabs`, `Tooltip`, `DropdownMenu`, `EmptyState`,
      `Skeleton`, table styles; restyle `button`, `input`, `card`, `dialog`.
- [ ] `components/shell`: `AppShell` (grid), `Rail`, `TopBar`,
      `Breadcrumb`, `CommandTrigger`, `AccountMenu`, `ContextPanel`,
      `Inspector`, `ShellProvider` (panel open state, breadcrumb, status
      pill), `useShellChords` (`g` chords).
- [ ] `router.tsx`: `AppShell` becomes the authenticated layout; add
      `/vaults` and `/repos` index routes (placeholder lists, finished in
      slices 3/5).
- [ ] Every page: drop its own header/`← Home`; register breadcrumb.
- [ ] Tests: shell (rail, chords, panel toggles, a11y), theme, kit.

## 2. Command palette
- [ ] `SearchOverlay` → grouped rows with icons, hints, `Kbd`; recents
      (last 8 destinations, localStorage); actions group; same a11y
      contract (combobox/listbox/activedescendant) and tests updated.
- [ ] `CommandTrigger` in the top bar opens it; `/` focuses it too.

## 3. Graph home + vaults index
- [ ] `GraphCanvas`: controls out of the canvas — outline → context
      panel, filters/physics → inspector sections, colour pills top-left,
      zoom controls bottom-right, notices bottom-left; stats strip.
- [ ] Inspector shows hovered/expanded community detail with member list.
- [ ] `pages/VaultsPage.tsx`: table, actions, trash, new vault (reuses
      `VaultActions`, `NewVaultForm`).

## 4. Vault + editor
- [ ] `VaultLayout`: tree in context panel, new-note pinned.
- [ ] `NoteView`: note bar (path, live pill, avatars, actions); property
      panel, revision history and sharing as inspector tabs.
- [ ] Trash panel reachable from the tree header.

## 5. Repositories
- [ ] `pages/ReposPage.tsx` index + connect.
- [ ] `RepositoryPage`: files in context panel, file bar, inspector tabs
      Sync · Webhook · Access · Symbols.

## 6. Team + Admin
- [ ] `TeamPage`: hero + roster table; management + reach in inspector.
- [ ] `AdminPage`: sections in context panel; `StatTile`s on Overview;
      tables restyled.

## 7. Settings + Auth
- [ ] `SettingsPage`: sections in context panel, one at a time,
      Appearance section with the theme switch; MFA mandate rule kept.
- [ ] Auth pages: shared `AuthFrame` (card, backdrop, wordmark, steps).

## 8. QA pass
- [ ] Screenshot every route in both themes at 1440×900 and 1024×768
      against the mock API; fix anything painted outside its cell.
- [ ] Full suite, bundle budget, lint, typecheck; README client section
      and STATE updated.
