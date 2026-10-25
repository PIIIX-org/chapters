-- #1007: the stored semantic edges are now a function of the content (search/semantic-edges.ts: an embed
-- recomputes the nodes whose top-k it changes, ties go by path). Edges stored before were each node's top-k
-- among the nodes that existed when it was embedded, so they depend on the order the instance was filled in.
-- This queues one `semantic_edges` job per live note and per repository file, at catch-up priority (1, behind
-- the jobs of writes); the server drains them in the background after boot, each recomputing one node's top-k
-- from its stored vectors (`pnpm reindex` queues the same jobs). One INSERT; the rebuild time is in the PR
-- for #1007. Numbered 0046 because open PRs hold 0041-0045; its `when` (1792900000000) is above theirs, so
-- it applies whatever order they merge in.
INSERT INTO "jobs" ("kind", "payload", "idempotency_key", "priority")
SELECT 'semantic_edges', jsonb_build_object('nodeType', n.type, 'nodeId', n.id::text), 'semantic_edges:' || n.type || ':' || n.id, 1
FROM (
  SELECT 'note' AS type, id FROM "notes" WHERE "deleted_at" IS NULL
  UNION ALL
  SELECT 'code', id FROM "repository_files"
) n
ORDER BY n.type DESC, n.id
ON CONFLICT ("idempotency_key") DO NOTHING;
