-- #479: delete, restore, rename and revert are history events. A rename keeps
-- the note's old and new path; a revert names the revision it brought back.
-- Additive and nullable (the 0021 rule, backup.md §5): code from before 0023
-- runs on it with no SQL. No foreign key on source_revision_id: a purged
-- revision leaves the revert row standing, and a backup restore inserts
-- revisions in any order.
ALTER TABLE "note_revisions" ADD COLUMN "source_revision_id" uuid, ADD COLUMN "from_path" text, ADD COLUMN "to_path" text;
