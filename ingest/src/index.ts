/**
 * papyri-ingest — public library API
 *
 * Core exports for programmatic use. The CLI entry is src/cli.ts.
 */

export { Ingester } from "./ingest.js";
export type { IngestOptions, ProgressCallback } from "./ingest.js";

export { GraphStore } from "./graphstore.js";
export type { Key } from "./graphstore.js";

export { FsBlobStore, keyToPath } from "./blob-store.js";
export type { BlobStore } from "./blob-store.js";

export { SqliteGraphDb } from "./graph-db.js";
export type { GraphDb, BatchStmt, GraphRow } from "./graph-db.js";

export { decode, encode, generatedDocToIngested, FIELD_ORDER } from "./encoder.js";
export type { IRNode, TypedNode, UnknownNode } from "./encoder.js";

export { assertBundle, explodeBundleToDir } from "./bundle.js";

export { collectForwardRefs, collectForwardRefsFromSection } from "./visitor.js";

export { FsRawStore } from "./raw-store.js";
export type { RawStore } from "./raw-store.js";

export {
  parseObjectsInv,
  registerProject,
  resolveExternalUri,
  storeInventory,
  unloadProject,
} from "./inventory.js";
export type { InventoryObject, ParsedInventory } from "./inventory.js";
