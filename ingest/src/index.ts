/**
 * papyri-ingest — public library API
 *
 * Core exports for programmatic use. The CLI entry is src/cli.ts.
 */

export { Ingester } from "./ingest.js";
export type { IngestOptions } from "./ingest.js";

export { GraphStore } from "./graphstore.js";
export type { Key } from "./graphstore.js";

export { FsBlobStore, R2BlobStore, keyToPath } from "./blob-store.js";
export type { BlobStore, R2BucketLike, R2ObjectLike } from "./blob-store.js";

export { SqliteGraphDb, D1GraphDb } from "./graph-db.js";
export type { GraphDb, BatchStmt, GraphRow, D1DatabaseLike, D1PreparedStatement } from "./graph-db.js";

export { decode, encode, generatedDocToIngested, FIELD_ORDER } from "./encoder.js";
export type { IRNode, TypedNode, UnknownNode } from "./encoder.js";

export { assertBundle, explodeBundleToDir } from "./bundle.js";

export { collectForwardRefs, collectForwardRefsFromSection } from "./visitor.js";
