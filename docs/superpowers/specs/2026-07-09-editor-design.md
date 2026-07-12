# Chapters — Editor

Sub-project 2 of 6. Structural design only — no implementation detail.

## Depends on

Sub-project 1 (Auth & Vault/Sharing model): every action here is scoped to a
vault and gated by that user's effective permission on it (`read`, `edit`,
or `owner`), as resolved by the access rule defined there.

## Goals

- Let a user browse a vault's notes and open one for viewing/editing.
- Live-preview markdown editing (renders as you type, Obsidian-style),
  built on CodeMirror 6.
- Keep every note OKF-compliant by construction: valid frontmatter, correct
  `type/name` path placement, no orphaned/untyped notes.
- Respect the read/edit permission from the Auth & Vault/Sharing model —
  read-only access renders notes but never allows edits.

## Layout

- **Sidebar**: a file tree mirroring the OKF `type/name` path convention
  (e.g. a `people/` folder listing all person notes). Clicking a note opens
  it in the editor pane.
- **Editor pane**: split into two parts —
  - a **structured property panel** at the top for frontmatter
    (`type`, `resource`, `tags`, `timestamp`, plus any extra OKF keys),
    presented as typed fields (dropdown for `type`, chip input for `tags`,
    etc.) rather than raw YAML text — guarantees the file's frontmatter is
    always valid OKF regardless of what the user does in the UI, which also
    matters for reliable AI/MCP parsing later.
  - the **note body**, live-preview markdown (CodeMirror 6): typed markdown
    syntax renders inline (headers get large, `**bold**` renders bold) as
    you type or move away, rather than showing raw markdown characters at
    rest.

## Note lifecycle

- **Create**: type-first flow — user picks a `type` (existing or new)
  before naming the note. The note's path (`type/name.md`) and folder
  placement in the sidebar tree are derived automatically from that choice,
  never manually specified. This guarantees every note has a valid `type`
  from the moment it's created.
- **Edit**: autosave, debounced shortly after the user stops typing. No
  explicit save action, no dirty/unsaved-changes indicator needed.
- **Rename/delete**: standard file-tree operations (rename updates the
  note's path/name; delete removes it), gated by `edit` permission on the
  containing vault.

## Permission-aware rendering

- `read`-only access: note opens in a rendered, non-editable state — both
  the property panel and the body are locked (no autocomplete popups, no
  autosave triggers, no create/rename/delete affordances).
- `edit` or `owner` access: full editor — property panel and body are both
  editable, autosave active, create/rename/delete available.
- This sub-project does not add any owner-only actions (sharing, mergeable
  toggle, etc.) — those live in the vault management UI defined by
  sub-project 1, not the note editor itself.

## Wikilinks

- Typing `[[` triggers autocomplete against existing notes in the current
  vault.
- A rendered `[[link]]` in live-preview mode is clickable and navigates to
  that note.
- Clicking a link to a note that doesn't exist yet **creates it** — inferring
  its `type` from context where possible (e.g. linking from within a
  `people/` note toward a name suggests `type: people`), otherwise falling
  back to the type-first creation flow so the new note is still
  OKF-compliant from the start.

## Explicitly out of scope for this sub-project

- **Backlinks / "linked mentions" panel** — deferred to the Graph engine
  sub-project (#3), which already needs to scan links vault-wide to build
  the graph; building link-indexing twice would be wasted work.
- **Multi-user concurrent editing** — deferred to the Real-time
  collaboration sub-project (#5). This sub-project is single-user save/load
  only; two people editing the same note at once is not handled here.
- **Full-text search** — sub-project #4.
- **Attachments** — out of scope for the whole product (notes are
  markdown-only, decided in sub-project 1's spec).

## Security hardening (audit follow-up, 2026-07-12)

Adopted from the security audit — see
`2026-07-12-security-audit-findings.md`.

### Server-side OKF validation (closes: validation was only a UI guarantee)

- OKF-schema and path validation (valid `type`, valid frontmatter shape,
  correct `type/name` placement, no path collisions) is enforced by a
  single shared server-side function, called by **every** write path —
  the browser editor's save, and the MCP write tool (sub-project 6) alike.
  The structured property panel described above is a UI convenience on
  top of this; it is never the only enforcement point.
- Type/name collisions (two notes that would resolve to the same path)
  are rejected at that same validation point, not just avoided by UI
  convention.

## Assumptions carried forward (revisit if wrong)

- `owner` permission behaves identically to `edit` for editing purposes —
  ownership only matters for vault-level actions (sharing, mergeable
  toggle), not note-level editing rights.
- Type inference on link-created notes is a best-effort convenience, not a
  guarantee — the type-first creation flow is always the fallback.
