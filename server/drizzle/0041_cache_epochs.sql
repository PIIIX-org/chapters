-- #680 (ADR-004 §2.9): the epochs every cache key carries (server/src/cache/key.ts).
-- A vault's or a repository's index epoch (`index_epochs`) moves with every committed change an
-- answer about it could show: notes and their revisions, blocks, wikilinks, semantic edges,
-- files, imports, the state of its embedding and extraction jobs, and its own row. One global
-- `instance_state.permission_epoch` moves with every change of who may read what: shares, team
-- memberships, MCP tokens, user status and role, vault and repository ownership.
--
-- Triggers, so every writer is covered (MCP, REST, the collab relay, workers, CLIs) without a
-- call in each. They are deferred constraint triggers: the bump runs at commit, inside the
-- writing transaction (a reader sees the change and the new epoch together, or neither), and
-- an epoch row is locked only while a transaction commits. One bump per scope per transaction:
-- a transaction-local setting lists the scopes already bumped. About 1.4 µs per changed row
-- (a 200,000-row insert: 495 ms with the trigger, 223 ms without).
--
-- The index epochs live in their own table, not in `vaults` / `repositories` columns as ADR-004
-- §2.9 first said: code locks those rows for its own reasons (the projector holds its vault's row
-- FOR SHARE while it writes, a sync updates its repository's row), and a commit-time bump of the
-- same row then waits on such a transaction while it waits on a row the committer holds
-- (a deadlock between a note restore and the projector, seen in store-schema.test.ts). Nothing
-- but the bumps locks an `index_epochs` row. A scope with no row has epoch 0; a deleted vault's or
-- repository's row goes with it.
-- Numbered 0041 with a `when` above 0040's (#1004, 1792600000000): open PRs hold 0039 and 0040.
CREATE TABLE "index_epochs" (
	"scope" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"epoch" bigint NOT NULL,
	CONSTRAINT "index_epochs_pkey" PRIMARY KEY ("scope", "scope_id")
);--> statement-breakpoint
ALTER TABLE "instance_state" ADD COLUMN "permission_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE FUNCTION index_epoch_bump(bump_scope text, bump_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  bumped text := coalesce(current_setting('elara.index_epochs_bumped', true), '');
  mark text := bump_scope || ':' || bump_id || ',';
  live boolean;
BEGIN
  IF bump_id IS NULL OR position(mark IN bumped) > 0 THEN RETURN; END IF;
  live := CASE bump_scope
    WHEN 'vault' THEN EXISTS (SELECT 1 FROM vaults v WHERE v.id = bump_id)
    ELSE EXISTS (SELECT 1 FROM repositories r WHERE r.id = bump_id) END;
  IF live THEN
    INSERT INTO index_epochs AS e (scope, scope_id, epoch) VALUES (bump_scope, bump_id, 1)
      ON CONFLICT (scope, scope_id) DO UPDATE SET epoch = e.epoch + 1;
  ELSE
    DELETE FROM index_epochs e WHERE e.scope = bump_scope AND e.scope_id = bump_id;
  END IF;
  PERFORM set_config('elara.index_epochs_bumped', bumped || mark, true);
END $$;--> statement-breakpoint
-- A note's vault, before and after (a move bumps both). Updates count when `seq` moves (body,
-- frontmatter, path or deleted_at: notes_bump_seq), or the vault, `updated_at` (recency ranks
-- and filters on it) or the versions of its blocks (search reports them as pending).
CREATE FUNCTION index_epoch_notes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM index_epoch_bump('vault', OLD.vault_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM index_epoch_bump('vault', NEW.vault_id); END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER notes_index_epoch AFTER INSERT OR DELETE ON "notes"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION index_epoch_notes();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER notes_index_epoch_update AFTER UPDATE ON "notes" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.seq, OLD.vault_id, OLD.updated_at, OLD.embedder_id, OLD.chunk_version) IS DISTINCT FROM (NEW.seq, NEW.vault_id, NEW.updated_at, NEW.embedder_id, NEW.chunk_version))
  EXECUTE FUNCTION index_epoch_notes();--> statement-breakpoint
-- A block's container: a note's vault or a file's repository (block replace, embedding and extraction completion).
CREATE FUNCTION index_epoch_blocks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  b blocks := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  PERFORM index_epoch_bump(CASE WHEN b.owner_type = 'note' THEN 'vault' ELSE 'repository' END, b.container_id);
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER blocks_index_epoch AFTER INSERT OR UPDATE OR DELETE ON "blocks"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION index_epoch_blocks();--> statement-breakpoint
-- A wikilink row: its source note's vault. A row deleted with its note finds no note at commit; the note's own trigger bumped.
CREATE FUNCTION index_epoch_note_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM index_epoch_bump('vault', (SELECT vault_id FROM notes WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.source_note_id ELSE NEW.source_note_id END));
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER note_links_index_epoch AFTER INSERT OR UPDATE OR DELETE ON "note_links"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION index_epoch_note_links();--> statement-breakpoint
-- A revision recorded or purged (note_history, get_revision): its note's vault. Compaction rewrites
-- how a revision is stored, not what it answers, so updates do not count.
CREATE FUNCTION index_epoch_note_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM index_epoch_bump('vault', (SELECT vault_id FROM notes WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.note_id ELSE NEW.note_id END));
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER note_revisions_index_epoch AFTER INSERT OR DELETE ON "note_revisions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION index_epoch_note_revisions();--> statement-breakpoint
-- A semantic edge: its source's vault or repository. An answer shows an edge only when both ends
-- are in its resources (graph/assemble.ts, D10), so its key holds the source's epoch too.
CREATE FUNCTION index_epoch_semantic_edges() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  e semantic_edges := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  IF e.node_a_type = 'note' THEN
    PERFORM index_epoch_bump('vault', (SELECT vault_id FROM notes WHERE id = e.node_a_id));
  ELSE
    PERFORM index_epoch_bump('repository', (SELECT repository_id FROM repository_files WHERE id = e.node_a_id));
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER semantic_edges_index_epoch AFTER INSERT OR UPDATE OR DELETE ON "semantic_edges"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION index_epoch_semantic_edges();--> statement-breakpoint
CREATE FUNCTION index_epoch_repository_files() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM index_epoch_bump('repository', OLD.repository_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM index_epoch_bump('repository', NEW.repository_id); END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER repository_files_index_epoch AFTER INSERT OR UPDATE OR DELETE ON "repository_files"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION index_epoch_repository_files();--> statement-breakpoint
-- An import row: its source file's repository (a row deleted with its file: the file's trigger bumped).
CREATE FUNCTION index_epoch_repository_file_imports() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM index_epoch_bump('repository',
    (SELECT repository_id FROM repository_files WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.source_file_id ELSE NEW.source_file_id END));
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER repository_file_imports_index_epoch AFTER INSERT OR UPDATE OR DELETE ON "repository_file_imports"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION index_epoch_repository_file_imports();--> statement-breakpoint
-- Embedding (`embed_note`) and extraction (`extract`) jobs: search reports how many items of a
-- scope are pending or failed (search.ts indexState), so a job enqueued, run again, finished,
-- failed for good or deleted bumps its note's vault or its file's repository. A claim (lease,
-- attempts) and a retried attempt's error (still pending) do not. The kinds are EMBEDDING_JOB
-- (search/embedding-queue.ts) and EXTRACTION_JOB (repositories/extraction-queue.ts); an
-- extraction job names its repository, or (older rows) only its file.
CREATE FUNCTION index_epoch_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  j jobs := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  uuid_text constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  job_note text := j.payload ->> 'noteId';
  job_repository text := j.payload ->> 'repositoryId';
  job_file text := j.payload ->> 'fileId';
BEGIN
  IF j.kind = 'embed_note' THEN
    IF job_note ~ uuid_text THEN
      PERFORM index_epoch_bump('vault', (SELECT n.vault_id FROM notes n WHERE n.id = job_note::uuid));
    END IF;
  ELSIF job_repository ~ uuid_text THEN
    PERFORM index_epoch_bump('repository', job_repository::uuid);
  ELSIF job_file ~ uuid_text THEN
    PERFORM index_epoch_bump('repository', (SELECT f.repository_id FROM repository_files f WHERE f.id = job_file::uuid));
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER jobs_index_epoch_insert AFTER INSERT ON "jobs" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.kind IN ('embed_note', 'extract')) EXECUTE FUNCTION index_epoch_jobs();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER jobs_index_epoch_delete AFTER DELETE ON "jobs" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.kind IN ('embed_note', 'extract')) EXECUTE FUNCTION index_epoch_jobs();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER jobs_index_epoch_update AFTER UPDATE OF "done_at", "last_error" ON "jobs" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.kind IN ('embed_note', 'extract')
    AND (OLD.done_at IS NULL, OLD.done_at IS NOT NULL AND OLD.last_error IS NOT NULL)
      IS DISTINCT FROM (NEW.done_at IS NULL, NEW.done_at IS NOT NULL AND NEW.last_error IS NOT NULL))
  EXECUTE FUNCTION index_epoch_jobs();--> statement-breakpoint
-- A change of the vault or repository row itself (a name answers show, a sync's status and
-- version, a trash or an owner change), and its delete (which drops its epoch row).
-- TG_ARGV[0]: 'vault' or 'repository'.
CREATE FUNCTION index_epoch_own_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM index_epoch_bump(TG_ARGV[0], CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END);
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER vaults_index_epoch AFTER DELETE ON "vaults"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION index_epoch_own_row('vault');--> statement-breakpoint
CREATE CONSTRAINT TRIGGER vaults_index_epoch_update AFTER UPDATE ON "vaults" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW)) EXECUTE FUNCTION index_epoch_own_row('vault');--> statement-breakpoint
CREATE CONSTRAINT TRIGGER repositories_index_epoch AFTER DELETE ON "repositories"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION index_epoch_own_row('repository');--> statement-breakpoint
CREATE CONSTRAINT TRIGGER repositories_index_epoch_update AFTER UPDATE ON "repositories" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW)) EXECUTE FUNCTION index_epoch_own_row('repository');--> statement-breakpoint
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
