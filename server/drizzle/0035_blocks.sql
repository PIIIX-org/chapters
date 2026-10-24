-- ADR-004 §2.5 (#413, #452a, #460): one `blocks` table holds the addressable
-- spans of repository files (symbol, skeleton and file blocks) and their
-- vectors; note blocks follow with #452b. It replaces
-- `repository_file_symbols` and `repository_files.embedding`, dropped below.
-- `owner_id` names a note or a file, so it has no foreign key: a statement
-- trigger deletes a repository file's blocks with the file (a repository
-- delete cascades to its files, which fires it too).
-- The columns are ADR-004 §2.5's plus `symbol_parent` (0034's `parent`:
-- `inner_path`, `parent.name`, cannot be split back when a name holds a `.`,
-- `namespace A.B`) and `snippet` (the symbol text keyword search matches, as
-- `repository_file_symbols.snippet` was). No separate (owner_type, owner_id)
-- index: the unique index serves it.
--
-- Not additive: code from before 0035 reads the dropped table and column, so
-- a code-only rollback over it needs the SQL in backup.md §5. The existing
-- vectors and symbols are carried over as `legacy:` blocks, so search keeps
-- answering from them; the first boot of the release re-extracts every file
-- (`chunk_version` 0 here, and the job key carries CHUNK_VERSION), which
-- replaces each file's legacy blocks by its real ones in one transaction.
-- A carried file vector's embed_key is computed from what made it, so that
-- re-extraction reuses it for the file block of a small file instead of
-- embedding the same text again. Numbered after 0034, with a larger `when`.
CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" "semantic_node_type" NOT NULL,
	"owner_id" uuid NOT NULL,
	"container_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"kind" text NOT NULL,
	"inner_path" text NOT NULL,
	"symbol_kind" text,
	"symbol_parent" text,
	"snippet" text,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"content_hash" text NOT NULL,
	"owner_version" text NOT NULL,
	"embed_key" text,
	"embedding" vector(384),
	CONSTRAINT "blocks_owner_block" UNIQUE ("owner_type", "owner_id", "block_id")
);--> statement-breakpoint
CREATE INDEX "blocks_container_idx" ON "blocks" USING btree ("container_id");--> statement-breakpoint
CREATE FUNCTION blocks_delete_repository_files() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM blocks b USING old_files o WHERE b.owner_type = 'code' AND b.owner_id = o.id;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER repository_files_delete_blocks AFTER DELETE ON "repository_files"
  REFERENCING OLD TABLE AS old_files FOR EACH STATEMENT EXECUTE FUNCTION blocks_delete_repository_files();--> statement-breakpoint
INSERT INTO "blocks" ("owner_type", "owner_id", "container_id", "block_id", "kind", "inner_path", "symbol_kind", "symbol_parent",
    "start_line", "end_line", "content_hash", "owner_version", "embed_key", "embedding")
  SELECT 'code', f.id, f.repository_id, 'legacy:file', 'file', '', NULL, NULL,
    1, CASE WHEN f.content = '' THEN 0
      ELSE length(f.content) - length(replace(f.content, E'\n', '')) + CASE WHEN right(f.content, 1) = E'\n' THEN 0 ELSE 1 END END,
    'legacy', 'legacy',
    -- embed-key.ts embedKey: what made the vector (#453's embedder_id) and its text, `<path>\n<content>` as a file block's
    -- (only when it was made from the current content).
    -- A file not extracted since 0033 (no extracted_hash, extractor_version 0) has a vector of its current content
    -- unless a job for that content is pending or failed (#453's legacyVectorCurrent rule).
    CASE WHEN f.embedder_id IS NULL OR NOT (f.extracted_hash IS NOT DISTINCT FROM f.content_hash OR (f.extracted_hash IS NULL AND f.extractor_version = 0
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.idempotency_key LIKE 'extract:' || f.id || ':' || f.content_hash || '%'
          AND (j.done_at IS NULL OR j.last_error IS NOT NULL)))) THEN 'legacy'
      ELSE left(encode(sha256(convert_to(f.embedder_id || E'\n' || f.path || E'\n' || f.content, 'UTF8')), 'hex'), 16) END,
    f.embedding
  FROM "repository_files" f WHERE f.embedding IS NOT NULL;--> statement-breakpoint
INSERT INTO "blocks" ("owner_type", "owner_id", "container_id", "block_id", "kind", "inner_path", "symbol_kind", "symbol_parent", "snippet",
    "start_line", "end_line", "content_hash", "owner_version", "embed_key", "embedding")
  SELECT 'code', s.file_id, f.repository_id, 'legacy:' || s.id, 'symbol', coalesce(s.parent || '.', '') || s.name, s.kind, s.parent, s.snippet,
    s.start_line, s.end_line, 'legacy', 'legacy', CASE WHEN s.embedding IS NULL THEN NULL ELSE 'legacy' END, s.embedding
  FROM "repository_file_symbols" s JOIN "repository_files" f ON f.id = s.file_id;--> statement-breakpoint
-- Built after the bulk inserts above (one build instead of one insert at a time).
CREATE INDEX "blocks_embedding_idx" ON "blocks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
-- embed-key.ts CHUNK_VERSION of a file's blocks (0: none yet); boot catch-up re-extracts a file of another version.
ALTER TABLE "repository_files" ADD COLUMN "chunk_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP TABLE "repository_file_symbols";--> statement-breakpoint
ALTER TABLE "repository_files" DROP COLUMN "embedding";
