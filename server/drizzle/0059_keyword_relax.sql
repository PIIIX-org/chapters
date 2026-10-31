-- #455 part 2: the keyword channel weights a file's fields and falls back to trigram similarity.
-- - `repository_files.keyword_head`: the fields of a file the code keyword leg ranks above its body, its path's and
--   its symbols' name lexemes (search/identifiers.ts `fieldKeywords`) with their English stems, written by extraction
--   in the statement that writes `keyword_fts` (which now holds them too). Current while
--   `extracted_hash = content_hash` and `extractor_version >= 7`; null until a file is extracted again
--   (EXTRACTOR_VERSION 7 makes the first boot re-extract every file; no vector is embedded again), and meanwhile the
--   leg ranks as before. Small (a path and a few names), so it has no index: the leg reads it only on the rows its
--   query matched.
-- - `notes.field_fts`: a note's fields, its path's words and its frontmatter `title` (English), generated and
--   stored like `fts` (so the table is rewritten once), with a GIN index: the note leg orders by it and its
--   relaxation ladder counts and filters on it. Computed per query, a 20,000-note vault's ladder took 762 ms (review
--   of #1037).
-- - `pg_trgm` (a trusted extension since Postgres 13, in the pgvector/pgvector images) and two trigram indexes for
--   the last-resort keyword leg, which matches a query term that matched nothing (a typo'd identifier) by word
--   similarity against file paths and symbol names, never bodies.
-- Numbered 0059 with a `when` (1793550000000, its #930 reservation) above those merged before it; a migration merged
-- later must take a larger `when`.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "repository_files" ADD COLUMN "keyword_head" tsvector;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "field_fts" tsvector GENERATED ALWAYS AS
  (to_tsvector('english', regexp_replace("path", '[/_.-]+', ' ', 'g') || ' ' || coalesce("frontmatter" ->> 'title', ''))) STORED;--> statement-breakpoint
CREATE INDEX "notes_field_fts_idx" ON "notes" USING gin ("field_fts");--> statement-breakpoint
CREATE INDEX "repository_files_path_trgm_idx" ON "repository_files" USING gin ("path" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "blocks_symbol_name_trgm_idx" ON "blocks" USING gin ("inner_path" gin_trgm_ops) WHERE "kind" = 'symbol';
