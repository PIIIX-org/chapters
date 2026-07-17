# Plan — Sub-project 2: Editor backend (notes + OKF)

Spec: `docs/superpowers/specs/2026-07-09-editor-design.md`. Backend scope
only — the CodeMirror UI comes in the UI phase; this delivers the storage,
validation, and endpoints it will sit on.

## Implementation-time decisions

- **Storage**: `DATA_DIR/vaults/<vaultId>/<type>/<name>.md` — plain OKF
  files, canonical. Atomic writes (temp file + rename).
- **DB note index**: `notes` table (path, type, name, frontmatter jsonb,
  body, timestamps, soft-delete columns) mirrors disk on every write via
  one shared code path. Derived data — rebuildable from disk; search
  (FTS/embeddings) and graph attach to it in later sub-projects.
- **One write path**: `notes/store.ts` is the single module that touches
  disk+DB. REST calls it now; CRDT persistence and MCP writes route
  through it later — this is where the spec's "single shared server-side
  validation on every write path" lives.
- **Validation** (`notes/okf.ts`, pure): `type`/`name` must be slugs
  (`[a-z0-9][a-z0-9-]*`, blocks traversal by construction), frontmatter
  `type` must match the path, `tags` string array, `timestamp` ISO
  string, extra scalar/array OKF keys allowed. Collisions rejected at
  the store level (partial unique index on live notes per vault).
- **Soft delete now, not in sub-project 6**: spec 6 demands one
  consistent delete behavior (trash + restore) for humans and MCP alike;
  building the mechanism with the first write path avoids retrofitting.
  Trash = `<vault>/.trash/<id>.md` + `deleted_at` on the index row.
- **`index.md` per type folder** (OKF convention): regenerated on any
  create/rename/delete in that folder — a listing of `[[type/name]]`
  links. Not indexed in the DB (it's derived output, not a note).
- **Rename** updates path/name only; wikilinks pointing at the old name
  are not rewritten (plain-file semantics; the graph re-scan reflects
  reality). Frontmatter `type` is immutable via rename across types —
  moving a note to another type folder is create+delete, not rename.
- **YAML**: `yaml` package + a small frontmatter fence splitter. No
  gray-matter dependency.

## Endpoints (all live-gated via `resolveAccess`)

- `GET  /vaults/:id/tree` — notes grouped by type (DB index)
- `POST /vaults/:id/notes` — type-first create `{type, name, frontmatter?, body?}` (edit)
- `GET  /vaults/:id/notes/<path>` — read from disk (read)
- `PUT  /vaults/:id/notes/<path>` — update frontmatter/body (edit; autosave target)
- `POST /vaults/:id/notes/rename` — `{from, to}` within a type (edit)
- `DELETE /vaults/:id/notes/<path>` — soft delete to trash (edit)
- `GET  /vaults/:id/trash` / `POST /vaults/:id/trash/:noteId/restore` (edit)

## Tasks

1. `okf.ts` validation + frontmatter parse/serialize, unit-tested.
2. `notes` table migration; `store.ts` (create/read/update/rename/
   soft-delete/restore/list + index.md regen), tested against real disk+DB.
3. REST routes with permission matrix tests (read-only user can read,
   not write; no access → 404).
