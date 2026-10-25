-- #454: search filters a note leg by tag inside its SQL (`frontmatter -> 'tags' ?| …`, search/search.ts
-- `noteFilter`), before the leg's cut, instead of after the fusion. Without an index the keyword leg reads
-- every full-text match and the vector leg every note of the vault; on 50,000 notes with a tag on 0.5% of them
-- this index took the keyword leg from 5-8 ms to 1.5 ms and the vector leg from 9-10 ms to 1.5 ms (2% of them:
-- 12-15 ms to 7 ms; measured in the #454 PR). jsonb_ops, the operator class that serves `?|`.
-- Numbered 0041 with a `when` above 0040's; a migration merged later must take a larger `when`.
CREATE INDEX IF NOT EXISTS "notes_tags_idx" ON "notes" USING gin (("frontmatter" -> 'tags'));
