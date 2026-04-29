-- Bundle-level tracking table.
--
-- One row per ingested (module, version) pair. Recorded by the ingest
-- pipeline when a .papyri artifact is uploaded via PUT /api/bundle.
-- The directory-based `papyri-ingest` CLI path does not populate this
-- table (no compressed artifact exists there).
--
-- bundle_size_bytes: byte length of the compressed .papyri artifact as
-- received by the upload endpoint. A proxy for "how big is this bundle"
-- useful for monitoring; exact deduplication accounting can be layered on
-- top later.
--
-- ingested_at: Unix epoch seconds (UTC) at ingest time.

CREATE TABLE bundles (
    module            TEXT    NOT NULL,
    version           TEXT    NOT NULL,
    bundle_size_bytes INTEGER NOT NULL,
    ingested_at       INTEGER NOT NULL,
    PRIMARY KEY (module, version)
)
