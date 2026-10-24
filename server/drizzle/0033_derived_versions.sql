-- #453: every derived artifact records what produced it. A repository
-- file's row carries the content hash, the extractor version and the
-- embedder id of its imports, symbols and vectors (written in one
-- transaction with them); a note carries the embedder id of its vector. Boot
-- catch-up re-derives rows whose values differ from their content and the
-- running code's EXTRACTOR_VERSION and EMBEDDER_ID. Additive (the 0021 rule,
-- backup.md §5): the defaults keep older code's writes working after a
-- code-only rollback. Numbered after 0032, with a larger `when`.
ALTER TABLE "repository_files" ADD COLUMN "extracted_hash" text;--> statement-breakpoint
ALTER TABLE "repository_files" ADD COLUMN "extractor_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repository_files" ADD COLUMN "embedder_id" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "embedder_id" text;--> statement-breakpoint
-- The vectors already stored were all made by EMBEDDER_ID
-- 'Xenova/bge-small-en-v1.5+text1': the model, its pooling and the note, file
-- and symbol embed texts are unchanged since they were written (model and
-- note text 1f05a6f, file text 3bc7a5b, symbol text 2c584d0; 31e960e's
-- batching and 16,000-character cut leave a 512-token model's vectors as
-- they were). They are stamped, so the upgrade does not re-embed them. A
-- row whose job for its current content or `seq` (pre-0033 key) is pending
-- or failed is not up to date: its content is left unstamped, so the boot
-- catch-up derives it again. Every file keeps `extractor_version` 0: the
-- first boot re-extracts each once (the import `line` backfill of #558),
-- reusing its stamped vectors, so that costs a parse per file. The trigger
-- `notes_bump_seq` does not fire on `embedder_id`.
UPDATE "repository_files" f SET "embedder_id" = 'Xenova/bge-small-en-v1.5+text1',
  "extracted_hash" = CASE WHEN NOT EXISTS (
    SELECT 1 FROM "jobs" j WHERE j."idempotency_key" = 'extract:' || f."id" || ':' || f."content_hash"
      AND (j."done_at" IS NULL OR j."last_error" IS NOT NULL)) THEN f."content_hash" END
WHERE f."embedding" IS NOT NULL;--> statement-breakpoint
UPDATE "notes" n SET "embedder_id" = 'Xenova/bge-small-en-v1.5+text1'
WHERE n."embedding" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "jobs" j WHERE j."idempotency_key" = 'embed_note:' || n."id" || ':' || n."seq"
    AND (j."done_at" IS NULL OR j."last_error" IS NOT NULL));--> statement-breakpoint
-- Job priority: a write's job (0) is claimed before catch-up's (1), so a
-- catch-up backlog never delays a new note's vector or a push's symbols.
ALTER TABLE "jobs" ADD COLUMN "priority" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_claim" ON "jobs" ("kind", "priority", "id") WHERE "done_at" IS NULL;
