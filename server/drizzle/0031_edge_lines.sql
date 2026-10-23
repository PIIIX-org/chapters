-- #558 (ADR-004 §2.8): edges say where they are written. A wikilink row
-- keeps the body-relative lines it is on, and a note may link one target on
-- several lines, so the line joins the key. An import row keeps the line of
-- its specifier. Additive (the 0021 rule, backup.md §5): the defaults keep
-- older code's inserts working after a code-only rollback; 0 means "not
-- located yet" and the boot backfill locates those rows from the bodies.
-- Imports extracted before this keep `line` null until extracted again
-- (#453). Numbered after 0030 (#425), with a larger `when`.
ALTER TABLE "note_links" ADD COLUMN "start_line" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "note_links" ADD COLUMN "end_line" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "note_links" DROP CONSTRAINT "note_links_source_note_id_target_path_pk";--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_source_note_id_target_path_start_line_pk" PRIMARY KEY("source_note_id","target_path","start_line");--> statement-breakpoint
CREATE INDEX "note_links_unlocated_idx" ON "note_links" ("source_note_id") WHERE start_line = 0;--> statement-breakpoint
ALTER TABLE "repository_file_imports" ADD COLUMN "line" integer;
