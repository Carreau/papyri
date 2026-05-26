-- External (intersphinx) inventory tables.
--
-- These hold a derived cache of Sphinx `objects.inv` inventories for projects
-- that do NOT publish papyri DocBundles. The viewer falls back to these rows
-- when a cross-package RefInfo cannot be resolved against an ingested bundle,
-- producing a real external href instead of a dead "unresolved" span.
--
-- Like everything else in the graphstore these are a rebuildable projection:
-- re-loading an inventory drops + rebuilds the project's rows
-- (see ingest/src/inventory.ts `storeInventory`). Stay within the SQL subset
-- D1 supports (no triggers/PRAGMAs here).

CREATE TABLE external_projects (
    name       TEXT PRIMARY KEY,
    base_url   TEXT NOT NULL,
    version    TEXT,
    fetched_at INTEGER
);

CREATE TABLE external_objects (
    project   TEXT NOT NULL REFERENCES external_projects (name) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    domain    TEXT NOT NULL,
    role      TEXT NOT NULL,
    uri       TEXT NOT NULL,
    dispname  TEXT,
    priority  INTEGER,
    PRIMARY KEY (project, name, domain, role)
);

CREATE INDEX idx_external_objects_name ON external_objects (project, name);
