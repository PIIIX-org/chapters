-- Private import metadata, never Git objects/content: snapshots may be pruned without losing the note identities/revs a client read.
CREATE TABLE vault_git_snapshots (
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  commit_id text NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, commit_id)
);
--> statement-breakpoint
-- Each applied note receipt commits in the SAME store transaction as its write.
-- Cross-note imports are deliberately non-atomic; these receipts make interrupted retries safe.
CREATE TABLE vault_git_push_operations (
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  commit_id text NOT NULL,
  path text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, connection_id, commit_id, path)
);
--> statement-breakpoint
-- Purge scrubs payloads to content-free effect tombstones. Keep the key after note removal so a retry cannot recreate it.
ALTER TABLE write_idempotency DROP CONSTRAINT write_idempotency_note_id_fkey;
--> statement-breakpoint
ALTER TABLE write_idempotency ADD CONSTRAINT write_idempotency_note_id_fkey FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL;
--> statement-breakpoint
-- Internal retention generation. The content-based seq trigger deliberately does not change seq for this column.
ALTER TABLE notes ADD COLUMN purge_epoch bigint NOT NULL DEFAULT 0;
