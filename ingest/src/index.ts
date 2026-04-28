/**
 * papyri-ingest — public library API
 *
 * Core exports for programmatic use. The CLI entry is src/cli.ts.
 */

export { Ingester } from "./ingest.js";
export type { IngestOptions } from "./ingest.js";

export { GraphStore } from "./graphstore.js";
export type { Key } from "./graphstore.js";

export { decode, encode, generatedDocToIngested, FIELD_ORDER } from "./encoder.js";
export type { IRNode, TypedNode, UnknownNode } from "./encoder.js";

export { assertBundle, explodeBundleToDir } from "./bundle.js";

export { collectForwardRefs, collectForwardRefsFromSection } from "./visitor.js";
