-- #680 (ADR-004 §2.9): the epochs every cache key carries (server/src/cache/key.ts).
-- A vault's or a repository's index epoch (`index_epochs`) moves with every committed change an
-- answer about it could show: notes and their revisions, blocks, wikilinks, semantic edges,
-- files, imports, the state of its embedding and extraction jobs, and its own row. One global
-- `instance_state.permission_epoch` moves with every change of who may read what: shares, team
-- memberships, MCP tokens, user status and role, vault and repository ownership.
--
-- Triggers, so every writer is covered (MCP, REST, the collab relay, workers, CLIs) without a
-- call in each. The bump runs at commit, inside the writing transaction: a reader sees the change
-- and the new epoch together, or neither, and an epoch row is locked only while a transaction
-- commits. An immediate bump would hold the epoch row from a transaction's first write to its
-- commit and deadlock with a writer that holds a row the first one writes next.
--
-- Index epochs, in two steps:
-- 1. A statement-level trigger per table and event reads its transition table and queues the
--    distinct scopes it touched in `index_epoch_pending` (this transaction's id, scope, id;
--    ON CONFLICT DO NOTHING). Per statement: one call, a DISTINCT over its rows, one probe per
--    scope; no call per row.
-- 2. A deferred constraint trigger on `index_epoch_pending` (constraint triggers are row-level:
--    one call per queued scope, so once per scope per transaction) bumps the epoch at commit and
--    removes the queued row. A scope whose vault or repository is gone loses its epoch row.
-- A 200,000-row insert (Postgres 17, a 2,000-vault scratch database): over 3 scopes 207-286 ms with
-- the triggers, 252-272 ms without; over 2,000 scopes 741 ms, 697-740 ms without. A row trigger per
-- changed row took 829-1,058 ms and 1,431-1,799 ms. One-row transactions: within run-to-run noise
-- of the row trigger.
--
-- The index epochs live in their own table, not in `vaults` / `repositories` columns as ADR-004
-- §2.9 first said: code locks those rows for its own reasons (the projector holds its vault's row
-- FOR SHARE while it writes, a sync updates its repository's row), and a commit-time bump of the
-- same row then waits on such a transaction while it waits on a row the committer holds
-- (a deadlock between a note restore and the projector, seen in store-schema.test.ts). Nothing
-- but the bumps locks an `index_epochs` row. A scope with no row has epoch 0.
-- Numbered 0041 with a `when` above 0040's (#1004, 1792600000000): open PRs hold 0039 and 0040.
CREATE TABLE "index_epochs" (
	"scope" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"epoch" bigint NOT NULL,
	CONSTRAINT "index_epochs_pkey" PRIMARY KEY ("scope", "scope_id")
);--> statement-breakpoint
-- Rows live only inside the transaction that queued them (removed at its commit; a rollback or a
-- crash leaves none), so the table is unlogged.
CREATE UNLOGGED TABLE "index_epoch_pending" (
	"xact" xid8 NOT NULL,
	"scope" text NOT NULL,
	"scope_id" uuid NOT NULL,
	CONSTRAINT "index_epoch_pending_pkey" PRIMARY KEY ("xact", "scope", "scope_id")
);--> statement-breakpoint
ALTER TABLE "instance_state" ADD COLUMN "permission_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE FUNCTION index_epoch_queue(queue_scope text, ids uuid[]) RETURNS void LANGUAGE sql AS $$
  INSERT INTO index_epoch_pending (xact, scope, scope_id)
  SELECT pg_current_xact_id(), queue_scope, u FROM unnest(ids) u WHERE u IS NOT NULL
  ON CONFLICT DO NOTHING
$$;--> statement-breakpoint
CREATE FUNCTION index_epoch_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  live boolean;
BEGIN
  live := CASE NEW.scope
    WHEN 'vault' THEN EXISTS (SELECT 1 FROM vaults v WHERE v.id = NEW.scope_id)
    ELSE EXISTS (SELECT 1 FROM repositories r WHERE r.id = NEW.scope_id) END;
  IF live THEN
    INSERT INTO index_epochs AS e (scope, scope_id, epoch) VALUES (NEW.scope, NEW.scope_id, 1)
      ON CONFLICT (scope, scope_id) DO UPDATE SET epoch = e.epoch + 1;
  ELSE
    DELETE FROM index_epochs e WHERE e.scope = NEW.scope AND e.scope_id = NEW.scope_id;
  END IF;
  DELETE FROM index_epoch_pending p WHERE p.xact = NEW.xact AND p.scope = NEW.scope AND p.scope_id = NEW.scope_id;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER index_epoch_pending_apply AFTER INSERT ON "index_epoch_pending"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION index_epoch_apply();--> statement-breakpoint
-- The statement triggers below name their transition tables `n` (new rows) and `o` (old rows);
-- each function runs only the branch of its event, so the other table's absence is never read.
-- Notes: a note's vault, before and after (a move bumps both). Updates count when `seq` moves
-- (body, frontmatter, path or deleted_at: notes_bump_seq), or the vault, `updated_at` (recency
-- ranks and filters on it) or the versions of its blocks (search reports them as pending).
CREATE FUNCTION index_epoch_notes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM index_epoch_queue('vault', ARRAY(SELECT DISTINCT vault_id FROM n));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM index_epoch_queue('vault', ARRAY(SELECT DISTINCT vault_id FROM o));
  ELSE
    PERFORM index_epoch_queue('vault', ARRAY(
      SELECT DISTINCT x.vault_id FROM n JOIN o ON o.id = n.id, LATERAL (VALUES (o.vault_id), (n.vault_id)) x(vault_id)
      WHERE (o.seq, o.vault_id, o.updated_at, o.embedder_id, o.chunk_version) IS DISTINCT FROM (n.seq, n.vault_id, n.updated_at, n.embedder_id, n.chunk_version)));
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER notes_index_epoch_insert AFTER INSERT ON "notes" REFERENCING NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_notes();--> statement-breakpoint
CREATE TRIGGER notes_index_epoch_update AFTER UPDATE ON "notes" REFERENCING OLD TABLE AS o NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_notes();--> statement-breakpoint
CREATE TRIGGER notes_index_epoch_delete AFTER DELETE ON "notes" REFERENCING OLD TABLE AS o
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_notes();--> statement-breakpoint
-- A block's container: a note's vault or a file's repository (block replace, embedding and extraction completion).
CREATE FUNCTION index_epoch_blocks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM index_epoch_queue('vault', ARRAY(SELECT DISTINCT container_id FROM n WHERE owner_type = 'note'));
    PERFORM index_epoch_queue('repository', ARRAY(SELECT DISTINCT container_id FROM n WHERE owner_type = 'code'));
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM index_epoch_queue('vault', ARRAY(SELECT DISTINCT container_id FROM o WHERE owner_type = 'note'));
    PERFORM index_epoch_queue('repository', ARRAY(SELECT DISTINCT container_id FROM o WHERE owner_type = 'code'));
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER blocks_index_epoch_insert AFTER INSERT ON "blocks" REFERENCING NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_blocks();--> statement-breakpoint
CREATE TRIGGER blocks_index_epoch_update AFTER UPDATE ON "blocks" REFERENCING OLD TABLE AS o NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_blocks();--> statement-breakpoint
CREATE TRIGGER blocks_index_epoch_delete AFTER DELETE ON "blocks" REFERENCING OLD TABLE AS o
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_blocks();--> statement-breakpoint
-- Wikilinks and revisions (recorded or purged: note_history, get_revision): the note's vault.
-- Rows deleted with their note find no note; the note's own trigger queued its vault.
-- Revision compaction rewrites how a revision is stored, not what it answers: no update trigger.
CREATE FUNCTION index_epoch_note_children() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'note_links' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM index_epoch_queue('vault', ARRAY(SELECT DISTINCT nt.vault_id FROM (SELECT DISTINCT source_note_id FROM n) r JOIN notes nt ON nt.id = r.source_note_id));
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM index_epoch_queue('vault', ARRAY(SELECT DISTINCT nt.vault_id FROM (SELECT DISTINCT source_note_id FROM o) r JOIN notes nt ON nt.id = r.source_note_id));
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM index_epoch_queue('vault', ARRAY(SELECT DISTINCT nt.vault_id FROM (SELECT DISTINCT note_id FROM n) r JOIN notes nt ON nt.id = r.note_id));
  ELSE
    PERFORM index_epoch_queue('vault', ARRAY(SELECT DISTINCT nt.vault_id FROM (SELECT DISTINCT note_id FROM o) r JOIN notes nt ON nt.id = r.note_id));
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER note_links_index_epoch_insert AFTER INSERT ON "note_links" REFERENCING NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_note_children();--> statement-breakpoint
CREATE TRIGGER note_links_index_epoch_update AFTER UPDATE ON "note_links" REFERENCING OLD TABLE AS o NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_note_children();--> statement-breakpoint
CREATE TRIGGER note_links_index_epoch_delete AFTER DELETE ON "note_links" REFERENCING OLD TABLE AS o
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_note_children();--> statement-breakpoint
CREATE TRIGGER note_revisions_index_epoch_insert AFTER INSERT ON "note_revisions" REFERENCING NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_note_children();--> statement-breakpoint
CREATE TRIGGER note_revisions_index_epoch_delete AFTER DELETE ON "note_revisions" REFERENCING OLD TABLE AS o
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_note_children();--> statement-breakpoint
-- A semantic edge: its source's vault or repository. An answer shows an edge only when both ends
-- are in its resources (graph/assemble.ts, D10), so its key holds the source's epoch too.
CREATE FUNCTION index_epoch_semantic_edges() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM index_epoch_queue('vault', ARRAY(SELECT DISTINCT nt.vault_id FROM (SELECT DISTINCT node_a_id FROM n WHERE node_a_type = 'note') r JOIN notes nt ON nt.id = r.node_a_id));
    PERFORM index_epoch_queue('repository', ARRAY(SELECT DISTINCT f.repository_id FROM (SELECT DISTINCT node_a_id FROM n WHERE node_a_type = 'code') r JOIN repository_files f ON f.id = r.node_a_id));
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM index_epoch_queue('vault', ARRAY(SELECT DISTINCT nt.vault_id FROM (SELECT DISTINCT node_a_id FROM o WHERE node_a_type = 'note') r JOIN notes nt ON nt.id = r.node_a_id));
    PERFORM index_epoch_queue('repository', ARRAY(SELECT DISTINCT f.repository_id FROM (SELECT DISTINCT node_a_id FROM o WHERE node_a_type = 'code') r JOIN repository_files f ON f.id = r.node_a_id));
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER semantic_edges_index_epoch_insert AFTER INSERT ON "semantic_edges" REFERENCING NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_semantic_edges();--> statement-breakpoint
CREATE TRIGGER semantic_edges_index_epoch_update AFTER UPDATE ON "semantic_edges" REFERENCING OLD TABLE AS o NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_semantic_edges();--> statement-breakpoint
CREATE TRIGGER semantic_edges_index_epoch_delete AFTER DELETE ON "semantic_edges" REFERENCING OLD TABLE AS o
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_semantic_edges();--> statement-breakpoint
-- Files: their repository. Imports: their source file's repository (rows deleted with their file:
-- the file's trigger queued it).
CREATE FUNCTION index_epoch_repository_files() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'repository_files' THEN
    IF TG_OP <> 'DELETE' THEN PERFORM index_epoch_queue('repository', ARRAY(SELECT DISTINCT repository_id FROM n)); END IF;
    IF TG_OP <> 'INSERT' THEN PERFORM index_epoch_queue('repository', ARRAY(SELECT DISTINCT repository_id FROM o)); END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM index_epoch_queue('repository', ARRAY(SELECT DISTINCT f.repository_id FROM (SELECT DISTINCT source_file_id FROM n) r JOIN repository_files f ON f.id = r.source_file_id));
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM index_epoch_queue('repository', ARRAY(SELECT DISTINCT f.repository_id FROM (SELECT DISTINCT source_file_id FROM o) r JOIN repository_files f ON f.id = r.source_file_id));
    END IF;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER repository_files_index_epoch_insert AFTER INSERT ON "repository_files" REFERENCING NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_repository_files();--> statement-breakpoint
CREATE TRIGGER repository_files_index_epoch_update AFTER UPDATE ON "repository_files" REFERENCING OLD TABLE AS o NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_repository_files();--> statement-breakpoint
CREATE TRIGGER repository_files_index_epoch_delete AFTER DELETE ON "repository_files" REFERENCING OLD TABLE AS o
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_repository_files();--> statement-breakpoint
CREATE TRIGGER repository_file_imports_index_epoch_insert AFTER INSERT ON "repository_file_imports" REFERENCING NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_repository_files();--> statement-breakpoint
CREATE TRIGGER repository_file_imports_index_epoch_update AFTER UPDATE ON "repository_file_imports" REFERENCING OLD TABLE AS o NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_repository_files();--> statement-breakpoint
CREATE TRIGGER repository_file_imports_index_epoch_delete AFTER DELETE ON "repository_file_imports" REFERENCING OLD TABLE AS o
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_repository_files();--> statement-breakpoint
-- Embedding (`embed_note`) and extraction (`extract`) jobs: search reports how many items of a
-- scope are pending or failed (search.ts indexState), so a job enqueued, run again, finished,
-- failed for good or deleted queues its note's vault or its file's repository. A claim (lease,
-- attempts) and a retried attempt's error (still pending) do not: an update counts only when the
-- job's state (pending, done, failed) changes. A re-run gets a new id, so old and new rows pair on
-- the idempotency key. The kinds are EMBEDDING_JOB (search/embedding-queue.ts) and EXTRACTION_JOB
-- (repositories/extraction-queue.ts); an extraction job names its repository, or (older rows) only its file.
CREATE FUNCTION index_epoch_job_scopes(kind text, payload jsonb, OUT scope text, OUT scope_id uuid) LANGUAGE plpgsql STABLE AS $$
DECLARE
  uuid_text constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  IF kind = 'embed_note' THEN
    scope := 'vault';
    IF payload ->> 'noteId' ~ uuid_text THEN
      SELECT nt.vault_id INTO scope_id FROM notes nt WHERE nt.id = (payload ->> 'noteId')::uuid;
    END IF;
  ELSE
    scope := 'repository';
    IF payload ->> 'repositoryId' ~ uuid_text THEN
      scope_id := (payload ->> 'repositoryId')::uuid;
    ELSIF payload ->> 'fileId' ~ uuid_text THEN
      SELECT f.repository_id INTO scope_id FROM repository_files f WHERE f.id = (payload ->> 'fileId')::uuid;
    END IF;
  END IF;
END $$;--> statement-breakpoint
CREATE FUNCTION index_epoch_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO index_epoch_pending (xact, scope, scope_id)
    SELECT DISTINCT pg_current_xact_id(), s.scope, s.scope_id FROM n, LATERAL index_epoch_job_scopes(n.kind, n.payload) s
    WHERE n.kind IN ('embed_note', 'extract') AND s.scope_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO index_epoch_pending (xact, scope, scope_id)
    SELECT DISTINCT pg_current_xact_id(), s.scope, s.scope_id FROM o, LATERAL index_epoch_job_scopes(o.kind, o.payload) s
    WHERE o.kind IN ('embed_note', 'extract') AND s.scope_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO index_epoch_pending (xact, scope, scope_id)
    SELECT DISTINCT pg_current_xact_id(), s.scope, s.scope_id
    FROM n JOIN o ON coalesce(o.idempotency_key, 'id:' || o.id) = coalesce(n.idempotency_key, 'id:' || n.id),
      LATERAL index_epoch_job_scopes(n.kind, n.payload) s
    WHERE n.kind IN ('embed_note', 'extract') AND s.scope_id IS NOT NULL
      AND (o.done_at IS NULL, o.done_at IS NOT NULL AND o.last_error IS NOT NULL)
        IS DISTINCT FROM (n.done_at IS NULL, n.done_at IS NOT NULL AND n.last_error IS NOT NULL)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER jobs_index_epoch_insert AFTER INSERT ON "jobs" REFERENCING NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_jobs();--> statement-breakpoint
CREATE TRIGGER jobs_index_epoch_update AFTER UPDATE ON "jobs" REFERENCING OLD TABLE AS o NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_jobs();--> statement-breakpoint
CREATE TRIGGER jobs_index_epoch_delete AFTER DELETE ON "jobs" REFERENCING OLD TABLE AS o
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_jobs();--> statement-breakpoint
-- A change of the vault or repository row itself (a name answers show, a sync's status and
-- version, a trash or an owner change), and its delete (whose apply drops its epoch row).
-- TG_ARGV[0]: 'vault' or 'repository'.
CREATE FUNCTION index_epoch_own_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM index_epoch_queue(TG_ARGV[0], ARRAY(SELECT id FROM o));
  ELSE
    PERFORM index_epoch_queue(TG_ARGV[0], ARRAY(SELECT n.id FROM n JOIN o ON o.id = n.id WHERE to_jsonb(o) IS DISTINCT FROM to_jsonb(n)));
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER vaults_index_epoch_update AFTER UPDATE ON "vaults" REFERENCING OLD TABLE AS o NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_own_row('vault');--> statement-breakpoint
CREATE TRIGGER vaults_index_epoch_delete AFTER DELETE ON "vaults" REFERENCING OLD TABLE AS o
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_own_row('vault');--> statement-breakpoint
CREATE TRIGGER repositories_index_epoch_update AFTER UPDATE ON "repositories" REFERENCING OLD TABLE AS o NEW TABLE AS n
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_own_row('repository');--> statement-breakpoint
CREATE TRIGGER repositories_index_epoch_delete AFTER DELETE ON "repositories" REFERENCING OLD TABLE AS o
  FOR EACH STATEMENT EXECUTE FUNCTION index_epoch_own_row('repository');--> statement-breakpoint
-- The permission epoch stays on deferred row triggers (constraint triggers are row-level, and its
-- single row must be locked only at commit). Its tables change a few rows per statement, and a
-- transaction-local flag makes every event after the first one setting read.
-- The permission epoch: one row, bumped once per transaction (the row exists once setup ran; the upsert covers an instance before it).
CREATE FUNCTION permission_epoch_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('elara.permission_epoch_bumped', true) IS DISTINCT FROM 'on' THEN
    INSERT INTO instance_state (id, permission_epoch) VALUES ('singleton', 1)
      ON CONFLICT (id) DO UPDATE SET permission_epoch = instance_state.permission_epoch + 1;
    PERFORM set_config('elara.permission_epoch_bumped', 'on', true);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER vault_shares_permission_epoch AFTER INSERT OR UPDATE OR DELETE ON "vault_shares"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION permission_epoch_bump();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER repository_shares_permission_epoch AFTER INSERT OR UPDATE OR DELETE ON "repository_shares"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION permission_epoch_bump();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER team_memberships_permission_epoch AFTER INSERT OR UPDATE OR DELETE ON "team_memberships"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION permission_epoch_bump();--> statement-breakpoint
-- A token: minted, deleted, or any change but its use (`last_used_at`, written on every call) and its label.
CREATE CONSTRAINT TRIGGER mcp_connections_permission_epoch AFTER INSERT OR DELETE ON "mcp_connections"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION permission_epoch_bump();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER mcp_connections_permission_epoch_update AFTER UPDATE ON "mcp_connections" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((to_jsonb(OLD) - 'last_used_at' - 'name') IS DISTINCT FROM (to_jsonb(NEW) - 'last_used_at' - 'name'))
  EXECUTE FUNCTION permission_epoch_bump();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER users_permission_epoch AFTER INSERT OR DELETE ON "users"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION permission_epoch_bump();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER users_permission_epoch_update AFTER UPDATE ON "users" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.status, OLD.role) IS DISTINCT FROM (NEW.status, NEW.role)) EXECUTE FUNCTION permission_epoch_bump();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER vaults_permission_epoch AFTER INSERT OR DELETE ON "vaults"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION permission_epoch_bump();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER vaults_permission_epoch_update AFTER UPDATE ON "vaults" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.owner_id, OLD.deleted_at) IS DISTINCT FROM (NEW.owner_id, NEW.deleted_at)) EXECUTE FUNCTION permission_epoch_bump();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER repositories_permission_epoch AFTER INSERT OR DELETE ON "repositories"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION permission_epoch_bump();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER repositories_permission_epoch_update AFTER UPDATE ON "repositories" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.owner_id IS DISTINCT FROM NEW.owner_id) EXECUTE FUNCTION permission_epoch_bump();
