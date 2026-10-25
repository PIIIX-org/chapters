-- #472: a wikilink row keeps the link's context, its paragraph or line (at
-- most 200 code points), for backlinks. Additive (the 0021 rule, backup.md
-- §5): older code's inserts leave it null after a code-only rollback. Null
-- means "not filled yet": the boot catch-up queues a `note_links` job per
-- note with such rows (rows without lines, from before 0031, have a null
-- context too), so the partial index that found unlocated rows now finds
-- unfilled ones. Numbered 0039 because open PR #999 holds 0038; its `when`
-- (1792450000000) is above that one's, so either may merge first.
ALTER TABLE "note_links" ADD COLUMN "context" text;--> statement-breakpoint
DROP INDEX IF EXISTS "note_links_unlocated_idx";--> statement-breakpoint
CREATE INDEX "note_links_unfilled_idx" ON "note_links" ("source_note_id") WHERE context IS NULL;
