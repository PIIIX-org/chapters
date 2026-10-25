-- #471 (owner decision D11, ADR-004 §2.9): every repository names the version
-- it was indexed at. `last_synced_commit` now holds the commit for every
-- ingestion method (git HEAD, the HEAD of a clean local git work tree, the
-- commit an agent push names), and `tree_hash` names the indexed files
-- whatever their source: the first 16 hex characters of sha256 over the
-- lines `path NUL content_hash LF`, in path byte order. Each sync writes it
-- from the rows it already holds (repositories/store.ts, computeTreeHash);
-- this backfill computes the same value for repositories that have files,
-- and gives a synced repository with none the tree of no files (sha256 of
-- nothing), as a sync does. A repository never synced keeps null.
-- Numbered 0040 because open PRs hold 0038 and 0039; its `when`
-- (1792600000000) is above theirs, so it applies whatever order they merge
-- in. It may need renumbering.
ALTER TABLE "repositories" ADD COLUMN "tree_hash" text;--> statement-breakpoint
UPDATE "repositories" r
SET "tree_hash" = t.tree
FROM (
  SELECT
    "repository_id",
    substr(
      encode(
        sha256(
          string_agg(
            convert_to("path", 'UTF8') || '\x00'::bytea || convert_to("content_hash", 'UTF8') || '\x0a'::bytea,
            ''::bytea
            ORDER BY "path" COLLATE "C"
          )
        ),
        'hex'
      ),
      1,
      16
    ) AS tree
  FROM "repository_files"
  GROUP BY "repository_id"
) t
WHERE r."id" = t."repository_id";--> statement-breakpoint
UPDATE "repositories" r
SET "tree_hash" = 'e3b0c44298fc1c14'
WHERE r."tree_hash" IS NULL
  AND r."last_synced_at" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "repository_files" f WHERE f."repository_id" = r."id");
