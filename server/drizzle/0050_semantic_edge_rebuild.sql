-- #1007: the stored semantic edges are now a function of the content (search/semantic-edges.ts: a node's
-- rows are its true top-k; an embed recomputes the nodes holding it and merges itself into the lists it
-- enters; ties go by path). Two changes:
-- 1. `similarity` becomes `double precision`, the value the search computes: an embed compares its own
--    similarity with a list's last row, and a `real` would round two different similarities into one.
--    Rewrites the table once (the values are kept, exactly).
-- 2. Edges stored before were each node's top-k among the nodes that existed when it was embedded, so they
--    depend on the order the instance was filled in. One `semantic_edges` job per live note and per
--    repository file is queued, at catch-up priority (1, behind the jobs of writes); the server drains them
--    in the background after boot, each recomputing one node's top-k from its stored vectors (`pnpm reindex`
--    queues the same jobs).
-- Times are in the PR for #1007. Numbered 0050 after dev's 0048, with a `when` (1793100000000) above every
-- migration before it; one merged later must take a larger `when`.
ALTER TABLE "semantic_edges" ALTER COLUMN "similarity" TYPE double precision;--> statement-breakpoint
INSERT INTO "jobs" ("kind", "payload", "idempotency_key", "priority")
SELECT 'semantic_edges', jsonb_build_object('nodeType', n.type, 'nodeId', n.id::text), 'semantic_edges:' || n.type || ':' || n.id, 1
FROM (
  SELECT 'note' AS type, id FROM "notes" WHERE "deleted_at" IS NULL
  UNION ALL
  SELECT 'code', id FROM "repository_files"
) n
ORDER BY n.type DESC, n.id
ON CONFLICT ("idempotency_key") DO NOTHING;
