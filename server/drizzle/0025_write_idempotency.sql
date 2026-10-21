-- #477 (ADR-003 S4): a write sent again with the same `idempotency_key` by the
-- same MCP connection, with the same arguments, returns the first write's
-- result instead of writing twice. The first result is kept here, keyed by
-- connection and key, for 24 hours (mcp/idempotency.ts). Additive (the 0021
-- rule, backup.md §5): a new table no older code reads or writes.
CREATE TABLE "write_idempotency" (
  "connection_id" uuid NOT NULL,
  "key" text NOT NULL,
  "tool" text NOT NULL,
  "args_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "write_idempotency_pkey" PRIMARY KEY ("connection_id", "key"),
  CONSTRAINT "write_idempotency_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "mcp_connections"("id") ON DELETE CASCADE
);
