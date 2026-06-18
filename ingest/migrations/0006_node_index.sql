-- Node index for fast lookup by type.
--
-- Precomputed at ingest time to support indexed SQL lookups in the viewer.
-- The image-index page and node browser scan all blobs (~25s for large bundles).
-- This table replaces that scan with a single indexed query.
--
-- Rows are populated by Ingester._populateNodeIndex() after bundle ingest.
-- A re-ingest deletes all rows for (pkg, ver) before repopulating.
--
-- content: JSON-encoded full IR node object (shock absorber for IR changes)
-- page_href: URL path for the page containing this node (e.g., /pkg/ver/numpy.array)
-- page_kind: page type: "api" | "docs" | "example"
-- page_qa: qualname or doc path (e.g., numpy.array)

CREATE TABLE IF NOT EXISTS node_index (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    pkg       TEXT NOT NULL,
    ver       TEXT NOT NULL,
    node_type TEXT NOT NULL,
    content   TEXT NOT NULL,
    page_href TEXT NOT NULL,
    page_kind TEXT NOT NULL,
    page_qa   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_node_index_pkg_ver_type ON node_index (pkg, ver, node_type);
