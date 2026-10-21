-- Why a file's last extraction embedded it only partly (#496): the per-file
-- symbol budget (ELARA_EMBED_MAX_SYMBOLS_PER_FILE) embeds the first N symbols
-- and stores the rest without a vector. Null = everything was embedded.
ALTER TABLE "repository_files" ADD COLUMN "embedding_note" text;
