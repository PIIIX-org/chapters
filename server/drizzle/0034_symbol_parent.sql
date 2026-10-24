-- #450: a method's class (or a namespace member's namespace) is stored
-- beside its bare name, so `find_symbols` still finds `save` by its exact
-- name and answers `parent: "Store"`. Null at module level, and on rows
-- extracted before this (EXTRACTOR_VERSION 3 re-extracts them at boot).
-- Additive (the 0021 rule, backup.md §5): older code ignores the column
-- after a code-only rollback.
ALTER TABLE "repository_file_symbols" ADD COLUMN "parent" text;
