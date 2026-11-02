-- #684 part B: a code block whose embedded text another repository of the same account already embedded reuses that
-- vector (repositories/blob-cache.ts `vectorsInAccount`). The lookup is by `embed_key` (model + text), so it needs an
-- index: partial, code blocks that have a vector. Numbered 0063 (reserved on #930).
CREATE INDEX "blocks_code_embed_key_idx" ON "blocks" ("embed_key") WHERE "owner_type" = 'code' AND "embedding" IS NOT NULL;
