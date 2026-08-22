-- semantic_edges became DIRECTED (#91): a row means "node_a holds node_b in
-- its top-k" and is owned by node_a. Rows written before this were canonically
-- ordered undirected pairs, so their node_a side is arbitrary.
--
-- Left alone, an edge whose real owner landed on the node_b side would be
-- deleted by node_a's next re-embed and never re-added -- the migration would
-- cause exactly the silent edge loss it is fixing. So mirror every existing
-- row: each direction is then owned by its source and is corrected on that
-- source's next re-embed. buildGraph() dedups both directions on read, so the
-- rendered graph is unchanged.
INSERT INTO semantic_edges (node_a_type, node_a_id, node_b_type, node_b_id, similarity)
SELECT node_b_type, node_b_id, node_a_type, node_a_id, similarity
FROM semantic_edges
ON CONFLICT (node_a_type, node_a_id, node_b_type, node_b_id) DO NOTHING;
