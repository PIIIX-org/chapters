-- ADR-004 §2.5 (#452b): a note's vectors move to `blocks` (its `preamble` and
-- `section` blocks, notes/note-blocks.ts), which replaces `notes.embedding`,
-- dropped below. As for repository files (0035), `owner_id` has no foreign
-- key: a statement trigger deletes a note's blocks with its row (a purge, or
-- a vault delete cascading to its notes).
--
-- Not additive: code from before 0036 reads the dropped column, so a
-- code-only rollback over it needs the SQL in backup.md §5. Each existing
-- vector is carried over as one `legacy:note` block spanning the body, so
-- the note vector leg keeps answering; the first boot of the release
-- re-embeds every note (`chunk_version` 0 here, and the `embed_note` job key
-- carries CHUNK_VERSION), which replaces a note's legacy block by its real
-- blocks in one transaction. Its embed_key is `legacy`: the old text
-- (`<path>\n<frontmatter JSON>\n<body>`) is no block's text, so nothing can
-- reuse it. Numbered after 0035, with a larger `when`.
CREATE FUNCTION blocks_delete_notes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM blocks b USING old_notes o WHERE b.owner_type = 'note' AND b.owner_id = o.id;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER notes_delete_blocks AFTER DELETE ON "notes"
  REFERENCING OLD TABLE AS old_notes FOR EACH STATEMENT EXECUTE FUNCTION blocks_delete_notes();--> statement-breakpoint
INSERT INTO "blocks" ("owner_type", "owner_id", "container_id", "block_id", "kind", "inner_path", "symbol_kind", "symbol_parent",
    "start_line", "end_line", "content_hash", "owner_version", "embed_key", "embedding")
  SELECT 'note', n.id, n.vault_id, 'legacy:note', 'preamble', '', NULL, NULL,
    1, CASE WHEN n.body = '' THEN 0
      ELSE length(n.body) - length(replace(n.body, E'\n', '')) + CASE WHEN right(n.body, 1) = E'\n' THEN 0 ELSE 1 END END,
    'legacy', 'legacy', 'legacy', n.embedding
  FROM "notes" n WHERE n.embedding IS NOT NULL;--> statement-breakpoint
-- embed-key.ts CHUNK_VERSION of a note's blocks (0: none yet); boot catch-up re-embeds a note of another version.
ALTER TABLE "notes" ADD COLUMN "chunk_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Drops `notes_embedding_idx` (HNSW) and `notes_missing_embeddings_idx` (0018) with it.
ALTER TABLE "notes" DROP COLUMN "embedding";--> statement-breakpoint
-- One HNSW index per owner type instead of one over all blocks: a note leg then walks a graph of note blocks
-- only (a vault has ~12 blocks a note), and code legs one of code blocks. Each vector query names its owner
-- type as a literal so the planner can use the partial index. Built after the carry-over insert above.
DROP INDEX "blocks_embedding_idx";--> statement-breakpoint
CREATE INDEX "blocks_note_embedding_idx" ON "blocks" USING hnsw ("embedding" vector_cosine_ops) WHERE "owner_type" = 'note';--> statement-breakpoint
CREATE INDEX "blocks_code_embedding_idx" ON "blocks" USING hnsw ("embedding" vector_cosine_ops) WHERE "owner_type" = 'code';
