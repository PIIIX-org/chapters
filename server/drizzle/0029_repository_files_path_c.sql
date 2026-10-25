-- #424: `browse_repository` reads a repository's files a page at a time, in
-- UTF-8 byte path order (`ORDER BY path COLLATE "C"`, `path > last`, a folder
-- as a `COLLATE "C"` range). `repository_files_repo_path` is in the
-- database's default collation (en_US.utf8 in the shipped image), which can
-- serve neither, so every page would read and sort the whole repository.
-- Additive (the 0021 rule, backup.md §5): an index older code never names.
-- Numbered after 0028 (#864), with a larger `when`.
CREATE INDEX "repository_files_repo_path_c" ON "repository_files" ("repository_id", "path" COLLATE "C");
