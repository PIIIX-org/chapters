-- #477 (ADR-003 S4): a write sent again with the same `idempotency_key` by the
-- same MCP connection, with the same arguments, returns the first write's
-- answer instead of writing twice. The answer is recorded in the write's own
-- transaction (so a crash after COMMIT cannot lose it), keyed by connection
-- and key, and pruned after 24 hours (mcp/write-result.ts). `note_id` ties a
-- key to the note it wrote, so purging the note deletes its keys and the
-- note text their answers hold. Additive (the 0021 rule, backup.md §5): a new
-- table no older code reads or writes.
CREATE TABLE "write_idempotency" (
  "connection_id" uuid NOT NULL,
  "key" text NOT NULL,
  "tool" text NOT NULL,
  "args_hash" text NOT NULL,
  "note_id" uuid,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "write_idempotency_pkey" PRIMARY KEY ("connection_id", "key"),
  CONSTRAINT "write_idempotency_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "mcp_connections"("id") ON DELETE CASCADE,
  CONSTRAINT "write_idempotency_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "write_idempotency_created_at" ON "write_idempotency" ("created_at");--> statement-breakpoint
CREATE INDEX "write_idempotency_note_id" ON "write_idempotency" ("note_id");
