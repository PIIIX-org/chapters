-- #453: every derived artifact records what produced it. A repository
-- file's row carries the content hash, the extractor version and the
-- embedder id of its imports, symbols and vectors (written in one
-- transaction with them); a note carries the embedder id of its vector. Boot
-- catch-up re-derives rows whose values differ from their content and the
-- running code's EXTRACTOR_VERSION and EMBEDDER_ID. Rows derived before this
-- keep null / 0: their producer is unknown, so the first boot re-derives them
-- once (in the background, the old rows searchable until each new result
-- commits); that is also how imports extracted before 0031 get their `line`
-- (#558). Additive (the 0021 rule, backup.md §5): the defaults keep older
-- code's writes working after a code-only rollback. Numbered after 0032, with
-- a larger `when`.
ALTER TABLE "repository_files" ADD COLUMN "extracted_hash" text;--> statement-breakpoint
ALTER TABLE "repository_files" ADD COLUMN "extractor_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repository_files" ADD COLUMN "embedder_id" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "embedder_id" text;
