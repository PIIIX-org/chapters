-- #408, #476: the `rev` an MCP connection last read of a note (read_note,
-- export_note), the base an edit_note `body` sent without `base_rev` is
-- three-way merged from (mcp/last-read.ts). In Postgres, so a server restart
-- between an agent's read and its edit does not turn the edit back into a
-- replace of the live text. Kept 24 hours, pruned on every read like
-- write_idempotency (0025); deleting the connection or purging the note
-- deletes its rows. Additive (the 0021 rule, backup.md §5): a new table no
-- older code reads or writes. Numbered after 0026 (#861) and 0027 (#869),
-- which must be applied first: the migrator skips a migration whose `when`
-- is at or below the newest applied one.
CREATE TABLE "note_reads" (
  "connection_id" uuid NOT NULL,
  "note_id" uuid NOT NULL,
  "rev" bigint NOT NULL,
  "read_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "note_reads_pkey" PRIMARY KEY ("connection_id", "note_id"),
  CONSTRAINT "note_reads_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "mcp_connections"("id") ON DELETE CASCADE,
  CONSTRAINT "note_reads_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "note_reads_read_at" ON "note_reads" ("read_at");--> statement-breakpoint
CREATE INDEX "note_reads_note_id" ON "note_reads" ("note_id");
