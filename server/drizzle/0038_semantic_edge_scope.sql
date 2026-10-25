-- #461 (D10 on #930): a node's semantic neighbours now come from its own vault (notes) or repository
-- (code), and a note↔code edge joins only one owner's resources (search/semantic-edges.ts). This deletes
-- the stored edges the scoped lookup no longer makes: note→note across vaults, code→code across
-- repositories, note↔code between two owners. An edge with a missing end is left to the reads, which
-- filter to live nodes. One pass over `semantic_edges` with hash joins (about 150 ms on 100,000 edges,
-- measured in the #461 PR), far cheaper than re-embedding every note and file to recompute the edges.
-- Numbered 0038 with a `when` above 0037's; a migration merged later must take a larger `when`.
WITH node AS (
  SELECT 'note'::semantic_node_type AS type, n.id, n.vault_id AS container_id, v.owner_id
    FROM notes n JOIN vaults v ON v.id = n.vault_id
  UNION ALL
  SELECT 'code'::semantic_node_type, f.id, f.repository_id, r.owner_id
    FROM repository_files f JOIN repositories r ON r.id = f.repository_id
)
DELETE FROM semantic_edges e
USING node a, node b
WHERE a.type = e.node_a_type AND a.id = e.node_a_id
  AND b.type = e.node_b_type AND b.id = e.node_b_id
  AND CASE WHEN e.node_a_type = e.node_b_type THEN a.container_id <> b.container_id ELSE a.owner_id <> b.owner_id END;
