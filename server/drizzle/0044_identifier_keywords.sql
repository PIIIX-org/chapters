-- #455: the keyword channel knows identifiers. Extraction stores each file's and each symbol's identifier
-- lexemes (search/identifiers.ts: `parseFrontmatter` as `parsefrontmatter`, `parse`, `frontmatter`; a path's
-- segments; unstemmed, positionless, `array_to_tsvector`) in `keywords`, written in the statements extraction
-- already runs, so no generated column or trigger recomputes them on other writes. Null until a file is
-- extracted again: EXTRACTOR_VERSION 5 makes the first boot re-extract every file (no vector is embedded
-- again), and meanwhile the code leg matches `fts` alone, as before.
-- The code keyword leg's document is `fts || coalesce(keywords, '')`: its GIN index replaces the one on
-- `fts`, which nothing else queries. Code from before 0044 still works over it (its `fts @@` scans the
-- repository's files). Symbol keywords have no index: the symbol leg ORs them with its ILIKE match, which
-- reads every symbol of the repository anyway.
-- Numbered 0044 with a `when` (1792800000000) above 0043's; a migration merged later must take a larger `when`.
ALTER TABLE "repository_files" ADD COLUMN "keywords" tsvector;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "keywords" tsvector;--> statement-breakpoint
DROP INDEX IF EXISTS "repository_files_fts_idx";--> statement-breakpoint
CREATE INDEX "repository_files_keyword_idx" ON "repository_files" USING gin (("fts" || coalesce("keywords", ''::tsvector)));
