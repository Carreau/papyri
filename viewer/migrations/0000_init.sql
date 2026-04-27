-- D1 graph store schema for the papyri viewer.
--
-- Mirrors `ingest/src/graphstore.ts` and `papyri/graphstore.py` exactly so
-- digests + queries port unchanged. Apply with:
--
--   pnpm wrangler d1 migrations apply papyri-viewer-graph --local
--
-- (or `--remote` to apply to a real D1 database). `wrangler` discovers this
-- file via `migrations_dir = "migrations"` in `wrangler.toml`.
--
-- The viewer expects an empty database after migrations: rows are written
-- by the Workers-side `PUT /api/bundle` handler (M9.3). There is no
-- parallel seeder — the bundle PUT endpoint is the single populator.

CREATE TABLE nodes (
    id         INTEGER PRIMARY KEY,
    package    TEXT NOT NULL,
    version    TEXT NOT NULL,
    category   TEXT NOT NULL,
    identifier TEXT NOT NULL,
    has_blob   INTEGER NOT NULL DEFAULT 0,
    digest     BLOB,
    UNIQUE (package, version, category, identifier)
);

CREATE TABLE links (
    source INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    dest   INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    PRIMARY KEY (source, dest)
);

CREATE INDEX idx_links_dest ON links (dest);
CREATE INDEX idx_nodes_pkg_cat_ident ON nodes (package, category, identifier);
