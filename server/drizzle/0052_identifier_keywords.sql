-- #455: the keyword channel knows identifiers. Extraction splits identifiers (search/identifiers.ts:
-- `parseFrontmatter` as `parsefrontmatter`, `parse`, `frontmatter`; a path's segments) into unstemmed,
-- positionless lexemes (`array_to_tsvector`) and writes them in the statements it already runs, so no generated
-- column or trigger recomputes them on other writes:
-- - `repository_files.keyword_fts`: the code keyword leg's document of the extracted content, the row's `fts`
--   plus those lexemes (stored whole: concatenating them at query time made the leg about 3x slower on rea's
--   3,757 files, 53-65 ms against 21 ms for `evidence id`). Current while `extracted_hash = content_hash` and
--   `extractor_version >= 6` (the version that writes it): a sync that changes the content, or older code
--   re-extracting the file after a rollback, makes the leg read `fts` until the file is extracted again.
-- - `blocks.keywords`: a symbol's lexemes (its inner_path only; its file's path belongs to the code file leg).
-- Both are null until a file is extracted again: EXTRACTOR_VERSION 6 makes the first boot re-extract every file
-- (no vector is embedded again), and meanwhile the legs match as before.
-- The GIN index on the code leg's document replaces the one on `fts`, which nothing else queries. Code from
-- before 0052 still works over it (its `fts @@` scans the repository's files). Symbol keywords have no index:
-- the symbol leg ORs them with its ILIKE match, which reads every symbol of the repository anyway.
-- Numbered 0052 with a `when` (1793200000000, its #930 reservation) above those merged before it; a migration merged
-- later must take a larger `when`.
ALTER TABLE "repository_files" ADD COLUMN "keyword_fts" tsvector;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "keywords" tsvector;--> statement-breakpoint
DROP INDEX IF EXISTS "repository_files_fts_idx";--> statement-breakpoint
CREATE INDEX "repository_files_keyword_idx" ON "repository_files" USING gin
  ((CASE WHEN "keyword_fts" IS NOT NULL AND "extracted_hash" = "content_hash" AND "extractor_version" >= 6
    THEN "keyword_fts" ELSE "fts" END));
