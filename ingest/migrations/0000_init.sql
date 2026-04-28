-- Papyri graph store schema.
--
-- Single source of truth for both consumers:
--
--   1. better-sqlite3 (Node / `papyri-ingest` CLI). `GraphStore` in
--      `ingest/src/graphstore.ts` reads this file at init time and
--      executes each statement against the local SQLite database.
--   2. Cloudflare D1 (Workers viewer). `viewer/wrangler.toml` points
--      `migrations_dir = "../ingest/migrations"` so the same file is
--      applied via `wrangler d1 migrations apply papyri-viewer-graph
--      --local` (or `--remote`).
--
-- Editing rules:
-- - Statements are separated by `;` and split naively on that character.
--   Don't put `;` inside string literals here.
-- - Add new schema as `0001_*.sql`, `0002_*.sql`, etc. so wrangler tracks
--   it as a migration. The TypeScript GraphStore reads every numbered
--   file in lexicographic order on init.
-- - Keep both consumers happy: stick to the SQL subset D1 supports
--   (no triggers, no FTS5, no PRAGMAs in migration files — those go in
--   the GraphStore constructor on the Node side).
--
-- The store is empty after migrations: rows are written by the ingest
-- pipeline (Node `Ingester` today; Workers-side `PUT /api/bundle` from
-- M9.3 onward).

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
