-- #682: read_note's `if_rev` answers `unchanged` only when no other note
-- held or left the note's path: a new note's `seq` starts at 1, so the `rev`
-- an agent has of a note deleted or moved away can equal the `rev` of a note
-- created there since (store.ts `pathHadOtherNote`). These partial indexes
-- keep that check to two index lookups: trashed notes by path (a live note
-- is unique per path), and revisions that moved a note away from a path.
-- Additive (the 0021 rule, backup.md §5): older code ignores them after a
-- code-only rollback.
CREATE INDEX "notes_vault_path_trashed" ON "notes" ("vault_id", "path") WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "note_revisions_from_path" ON "note_revisions" ("from_path") WHERE from_path IS NOT NULL;
