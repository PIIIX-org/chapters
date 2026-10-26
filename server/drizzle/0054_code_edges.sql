-- #469 (ADR-004 §2.8): symbol-level code edges, extracted with the symbols (repositories/code-edges.ts), beside
-- `repository_file_imports` (which stays: graph, staleness and the import backfill read it). One row per call,
-- reference or imported name a file writes, plus one `test` row per name a test file uses: its line and column
-- (1-based, UTF-16 code units), its enclosing symbol block, the name and its qualified form, and the target symbol
-- block when one is found (`resolved` through the file's scope, imports or package; `textual` when matched by name
-- only). The primary key is the site, so it also serves "edges of a file by line"; the other two indexes serve
-- "edges to a symbol" and "edges by name" (#470), and the incremental re-resolution by name.
-- The table starts empty: EXTRACTOR_VERSION 7 makes boot catch-up re-extract every file, which fills it.
-- `blocks_symbol_name_idx` finds a repository's symbol blocks by bare name (`inner_path` without its parent):
-- resolution looks names up there. `repository_files.edge_note` says when a file's edges were capped.
-- Numbered 0054 with a `when` (1793300000000) above every migration before it (reserved on #930).
CREATE TABLE "code_edges" (
	"source_file_id" uuid NOT NULL REFERENCES "repository_files"("id") ON DELETE CASCADE,
	"line" integer NOT NULL,
	"col" integer NOT NULL,
	"kind" text NOT NULL CHECK ("kind" IN ('call', 'reference', 'import', 'test')),
	"repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
	"source_block_id" text,
	"target_name" text NOT NULL,
	"target_qualified" text,
	"via" text,
	"member" boolean NOT NULL DEFAULT false,
	"target_file_id" uuid,
	"target_block_id" text,
	"confidence" text NOT NULL CHECK ("confidence" IN ('resolved', 'textual')),
	"context" text NOT NULL,
	PRIMARY KEY ("source_file_id", "line", "col", "kind")
);--> statement-breakpoint
CREATE INDEX "code_edges_target_idx" ON "code_edges" ("target_file_id", "target_block_id") WHERE "target_file_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "code_edges_name_idx" ON "code_edges" ("repository_id", "target_name");--> statement-breakpoint
CREATE INDEX "blocks_symbol_name_idx" ON "blocks" ("container_id", (CASE WHEN "symbol_parent" IS NULL THEN "inner_path" ELSE substr("inner_path", length("symbol_parent") + 2) END)) WHERE "owner_type" = 'code' AND "kind" = 'symbol';--> statement-breakpoint
ALTER TABLE "repository_files" ADD COLUMN "edge_note" text;
