-- #858: the admin security-event log lists events in the order they were
-- recorded, not by `created_at`. `created_at` comes from the database clock,
-- which can step back or give events the same instant (every row of one
-- insert); `seq` comes from a sequence, as `note_revisions.ord` does (0024).
-- Rows recorded before this migration get `seq` in (created_at, id) order.
-- Additive (the 0021 rule, backup.md §5): the column has a lasting default, so
-- code from before 0027 records events with no SQL and keeps listing them by
-- `created_at`.
CREATE SEQUENCE "security_events_seq_seq" AS bigint;--> statement-breakpoint
ALTER TABLE "security_events" ADD COLUMN "seq" bigint;--> statement-breakpoint
UPDATE "security_events" e SET "seq" = o.n
  FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS n FROM "security_events") o
  WHERE e."id" = o."id";--> statement-breakpoint
SELECT setval('security_events_seq_seq', (SELECT count(*) FROM "security_events") + 1, false);--> statement-breakpoint
ALTER TABLE "security_events" ALTER COLUMN "seq" SET DEFAULT nextval('security_events_seq_seq'), ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
ALTER SEQUENCE "security_events_seq_seq" OWNED BY "security_events"."seq";--> statement-breakpoint
CREATE INDEX "security_events_seq_idx" ON "security_events" ("seq");
