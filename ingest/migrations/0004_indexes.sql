-- Performance indexes for common read queries.
--
-- idx_nodes_pkg_ident: covers getBackrefs, which filters nodes by
-- (package, identifier) without a fixed category or version.  The existing
-- idx_nodes_pkg_cat_ident has `category` before `identifier`, so the
-- optimizer cannot skip to `identifier` efficiently for that query.
--
-- idx_nodes_blob_pkg_ver: covering partial index for listBundlesViaGraph,
-- which does `SELECT DISTINCT package, version FROM nodes WHERE has_blob=1`.
-- Without this the query is a full table scan; the partial index contains
-- only the has_blob=1 rows and carries both columns needed, so SQLite
-- satisfies the query entirely from the index.

CREATE INDEX IF NOT EXISTS idx_nodes_pkg_ident ON nodes (package, identifier);

CREATE INDEX IF NOT EXISTS idx_nodes_blob_pkg_ver ON nodes (package, version) WHERE has_blob=1;
