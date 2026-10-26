-- #464: a repository file's Markdown/HTML `section` blocks are outline blocks,
-- never embedded (repositories/code-blocks.ts); #414/#415 decide whether they
-- get vectors. Earlier heads of #464's PR embedded them, and a file those
-- heads extracted carries EXTRACTOR_VERSION 5 already, so no catch-up would
-- extract it again: clear those vectors here. A no-op on any instance that
-- never ran those heads. Additive (the 0021 rule, backup.md §5): older code
-- never wrote code sections, and its re-extraction writes them unembedded too.
-- Numbered 0048 (`when` 1793000000000) per the reservation table on #930:
-- drizzle applies only journal entries newer than the last one applied, so
-- this comes after the 0044-0047 migrations that land before it.
UPDATE "blocks" SET "embedding" = NULL, "embed_key" = NULL
WHERE "owner_type" = 'code' AND "kind" = 'section' AND ("embedding" IS NOT NULL OR "embed_key" IS NOT NULL);
