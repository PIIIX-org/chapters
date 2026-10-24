-- #453: every derived artifact records what produced it. A repository
-- file's row carries the content hash, the extractor version and the
-- embedder id of its imports, symbols and vectors (written in one
-- transaction with them); a note carries the embedder id of its vector. Boot
-- catch-up re-derives rows whose values differ from their content and the
-- running code's EXTRACTOR_VERSION and EMBEDDER_ID. Additive (the 0021 rule,
-- backup.md §5): the defaults keep older code's writes working after a
-- code-only rollback. Numbered after 0032, with a larger `when`.
--
-- No existing row is rewritten (a rewrite of every note and file with a
-- vector held the boot for minutes on 100k notes). The vectors already
-- stored were all made by EMBEDDER_ID 'Xenova/bge-small-en-v1.5+text1': the
-- model, its pooling and the note, file and symbol embed texts are unchanged
-- since they were written (model and note text 1f05a6f, file text 3bc7a5b,
-- symbol text 2c584d0; 31e960e's batching and 16,000-character cut leave a
-- 512-token model's vectors as they were). A column added with a constant
-- default gives every existing row that value from the catalog, without a
-- rewrite (PostgreSQL 11+), and dropping the default afterwards keeps it for
-- them, so rows written later start without one. The id means "made the
-- vector" only where there is a vector; the code checks `embedding` first.
ALTER TABLE "repository_files" ADD COLUMN "extracted_hash" text;--> statement-breakpoint
ALTER TABLE "repository_files" ADD COLUMN "extractor_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repository_files" ADD COLUMN "embedder_id" text DEFAULT 'Xenova/bge-small-en-v1.5+text1';--> statement-breakpoint
ALTER TABLE "repository_files" ALTER COLUMN "embedder_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "embedder_id" text DEFAULT 'Xenova/bge-small-en-v1.5+text1';--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "embedder_id" DROP DEFAULT;--> statement-breakpoint
-- A note whose pre-0033 embedding job for its current `seq` is pending or
-- failed has a vector of an earlier text: no id, so the boot catch-up embeds
-- it. Few rows, reached from `jobs` by primary key. (Files need no such step:
-- every one is re-extracted once, keeping a pre-0033 file vector only when no
-- such job exists for its content, see extraction-queue.ts.)
UPDATE "notes" n SET "embedder_id" = NULL
FROM (
  SELECT m[1]::uuid AS id, m[2]::bigint AS seq FROM (
    SELECT regexp_match("idempotency_key", '^embed_note:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]+)$') AS m
    FROM "jobs" WHERE "kind" = 'embed_note' AND ("done_at" IS NULL OR "last_error" IS NOT NULL)
  ) k WHERE m IS NOT NULL
) s
WHERE n."id" = s.id AND n."seq" = s.seq;--> statement-breakpoint
-- Job priority: a write's job (0) is claimed before catch-up's (1), so a
-- catch-up backlog never delays a new note's vector or a push's symbols.
ALTER TABLE "jobs" ADD COLUMN "priority" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_claim" ON "jobs" ("kind", "priority", "id") WHERE "done_at" IS NULL;
