/**
 * Bundle Node validation.
 *
 * `papyri pack` writes a `.papyri` artifact = gzip(canonical-CBOR(Bundle)).
 * Callers (the viewer's upload endpoint, the standalone CLI) gunzip +
 * cbor-decode the bytes to a Bundle TypedNode and pass it to
 * `Ingester.ingestBundle`. This module type-narrows that decoded value to a
 * `BundleNode` before ingest runs.
 */
import type { TypedNode } from "./encoder.js";

interface BundleNode extends TypedNode {
  __type: "Bundle";
  module: string;
  version: string;
  summary: string;
  github_slug: string;
  tag: string;
  logo: string;
  aliases: Record<string, string>;
  extra: Record<string, unknown>;
  api: Record<string, TypedNode>;
  narrative: Record<string, TypedNode>;
  examples: Record<string, TypedNode>;
  assets: Record<string, Uint8Array | Buffer>;
  toc: TypedNode[];
}

/** Type-narrowing assert that *node* is a Bundle (tag 4070). */
export function assertBundle(node: unknown): asserts node is BundleNode {
  if (!node || typeof node !== "object") {
    throw new Error("expected a Bundle Node, got non-object");
  }
  const n = node as TypedNode;
  if (n.__type !== "Bundle" || n.__tag !== 4070) {
    throw new Error(
      `expected a Bundle Node (tag 4070, type "Bundle"), got ${
        typeof n.__type === "string" ? n.__type : "untyped"
      } (tag ${typeof n.__tag === "number" ? n.__tag : "?"})`,
    );
  }
}
