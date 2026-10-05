-- Elara Chroma Edition: Decouple vector storage from PostgreSQL
-- Dropping HNSW indexes on vector columns. Vector indexing is offloaded to Chroma.
DROP INDEX IF EXISTS "notes_embedding_idx";
DROP INDEX IF EXISTS "repository_files_embedding_idx";
DROP INDEX IF EXISTS "repository_file_symbols_embedding_idx";

ALTER TABLE "notes" DROP COLUMN IF EXISTS "embedding";
ALTER TABLE "repository_files" DROP COLUMN IF EXISTS "embedding";
ALTER TABLE "repository_file_symbols" DROP COLUMN IF EXISTS "embedding";

ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "embedded_at" timestamp with time zone;
ALTER TABLE "repository_files" ADD COLUMN IF NOT EXISTS "embedded_at" timestamp with time zone;

DROP EXTENSION IF EXISTS vector;
