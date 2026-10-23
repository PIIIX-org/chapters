-- #425: `browse_vault` reads a folder of a vault a page at a time, in
-- code-unit path order (`ORDER BY path COLLATE "C"`, `path > last`, a folder
-- as a `COLLATE "C"` range). `notes_vault_path_live` is in the database's
-- default collation, which can serve neither, so every page would read and
-- sort the whole vault. Additive (the 0021 rule, backup.md §5): an index
-- older code never names. Numbered after 0029 (#424), with a larger `when`.
CREATE INDEX "notes_vault_path_c_live" ON "notes" ("vault_id", "path" COLLATE "C") WHERE deleted_at is null;
