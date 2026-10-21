-- #825, #811: a note's revisions are ordered by when they were recorded, not
-- by `created_at`. `created_at` comes from the database clock, which can step
-- back or give two revisions the same instant; `ord` comes from a sequence.
-- Rows recorded before this migration get `ord` in (created_at, id) order,
-- the order they were listed in. Additive (the 0021 rule, backup.md §5): the
-- column has a lasting default, so code from before 0024 records revisions
-- with no SQL and keeps listing them by `created_at`.
CREATE SEQUENCE "note_revisions_ord_seq" AS bigint;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD COLUMN "ord" bigint;--> statement-breakpoint
UPDATE "note_revisions" r SET "ord" = o.n
  FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS n FROM "note_revisions") o
  WHERE r."id" = o."id";--> statement-breakpoint
SELECT setval('note_revisions_ord_seq', (SELECT count(*) FROM "note_revisions") + 1, false);--> statement-breakpoint
ALTER TABLE "note_revisions" ALTER COLUMN "ord" SET DEFAULT nextval('note_revisions_ord_seq'), ALTER COLUMN "ord" SET NOT NULL;--> statement-breakpoint
ALTER SEQUENCE "note_revisions_ord_seq" OWNED BY "note_revisions"."ord";--> statement-breakpoint
CREATE INDEX "note_revisions_note_ord" ON "note_revisions" ("note_id", "ord");
