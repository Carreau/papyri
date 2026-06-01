-- Additional indexes for query-performance hot paths identified after load
-- testing.
--
-- idx_nodes_broken: partial index for (package, version) WHERE has_blob=0.
-- Covers the destination-node lookup in countBrokenBackrefs (graph.ts),
-- which runs on every bundle-index page load to compute the broken-incoming-
-- links badge count.  The complementary has_blob=1 partial index already
-- exists as idx_nodes_blob_pkg_ver (0004_indexes.sql).
CREATE INDEX IF NOT EXISTS idx_nodes_broken ON nodes (package, version) WHERE has_blob=0;
