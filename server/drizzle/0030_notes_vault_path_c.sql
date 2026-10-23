-- #425: `browse_vault` reads a folder of a vault a page at a time, in
-- code-unit path order. `notes_vault_path_live` is in the database's default
-- collation, which serves neither `ORDER BY path COLLATE "C"` nor a folder as
-- a `COLLATE "C"` range, so every page would read and sort the whole vault.
-- `notes_vault_path_c_live`: a subtree (`recursive`) and the note count under
-- a subfolder. `notes_vault_dir_c_live`: the notes directly in a folder (the
-- folder with its trailing '/', '' at the root), and its subfolders one probe
-- each; `browseNotesPage`/`browseSubfoldersPage` repeat the expression.
-- Additive (the 0021 rule, backup.md §5): indexes older code never names.
-- A plain CREATE INDEX (drizzle runs a migration in a transaction, so not
-- CONCURRENTLY): writes to `notes` wait while it builds (backup.md §5).
-- Numbered after 0029 (#424), with a larger `when`.
CREATE INDEX "notes_vault_path_c_live" ON "notes" ("vault_id", "path" COLLATE "C") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "notes_vault_dir_c_live" ON "notes" ("vault_id", (coalesce(substring("path" from '^(.*/)'), '')) COLLATE "C", "path" COLLATE "C") WHERE deleted_at is null;
