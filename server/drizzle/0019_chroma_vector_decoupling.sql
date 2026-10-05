-- Elara Chroma Edition: Decouple vector storage from PostgreSQL
-- Dropping HNSW indexes on vector columns. Vector indexing is offloaded to Chroma.
DROP INDEX IF EXISTS "notes_embedding_idx";
DROP INDEX IF EXISTS "repository_files_embedding_idx";
DROP INDEX IF EXISTS "repository_file_symbols_embedding_idx";
