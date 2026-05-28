-- Papyri graph store schema.
--
-- Single source of truth, applied by `applyMigrations` in
-- `ingest/src/ingest.ts`. Both the standalone `papyri-ingest` init path and
-- the long-running viewer (`viewer/src/lib/backends.ts`) call it against the
-- same better-sqlite3 database under `~/.papyri/ingest/`.
--
-- Versioning uses `PRAGMA user_version`: a file named `NNNN_*.sql` carries
-- version `NNNN`, and the runner applies only files whose number is greater
-- than the DB's stored `user_version`, in ascending order. The viewer calls
-- this on startup, so a new migration reaches a live DB without a wipe.
-- Files are 1-indexed (this one is `0001`) because `user_version` defaults
-- to 0 on a fresh DB, so a migration numbered `0000` could never be
-- distinguished from "already applied".
--
-- Editing rules:
-- - Statements are separated by `;` and split naively on that character.
--   Don't put `;` inside string literals here.
-- - Add new schema as the next numbered file (`0006_*.sql`, …). Each file's
--   number must be unique — the version gate keys off it.
-- - Prefer `CREATE TABLE/INDEX IF NOT EXISTS` so an accidental re-run is a
--   no-op. `ALTER TABLE ADD COLUMN` has no `IF NOT EXISTS`; the version gate
--   keeps it running exactly once.
-- - No PRAGMAs in migration files — those live in the `PRAGMAS` list in
--   `ingest.ts`, and the runner emits the `user_version` bump itself.
--
-- The store is empty after migrations: rows are written by the ingest
-- pipeline (`Ingester`, via the viewer's `PUT /api/bundle`).

CREATE TABLE IF NOT EXISTS nodes (
    id         INTEGER PRIMARY KEY,
    package    TEXT NOT NULL,
    version    TEXT NOT NULL,
    category   TEXT NOT NULL,
    identifier TEXT NOT NULL,
    has_blob   INTEGER NOT NULL DEFAULT 0,
    digest     BLOB,
    UNIQUE (package, version, category, identifier)
);

CREATE TABLE IF NOT EXISTS links (
    source INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    dest   INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    PRIMARY KEY (source, dest)
);

CREATE INDEX IF NOT EXISTS idx_links_dest ON links (dest);
CREATE INDEX IF NOT EXISTS idx_nodes_pkg_cat_ident ON nodes (package, category, identifier);
