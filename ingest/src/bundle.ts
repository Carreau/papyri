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
import { isSafeUrl } from "./url-safety.js";

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

const URL_BEARING_TYPES = new Set(["Link", "Image"]);

function collectUnsafeUrls(val: unknown, out: string[]): void {
  if (!val || typeof val !== "object") return;
  if (Array.isArray(val)) {
    for (const item of val) collectUnsafeUrls(item, out);
    return;
  }
  const node = val as Record<string, unknown>;
  if (
    typeof node.__type === "string" &&
    URL_BEARING_TYPES.has(node.__type) &&
    typeof node.url === "string" &&
    !isSafeUrl(node.url)
  ) {
    out.push(node.url);
  }
  for (const v of Object.values(node)) collectUnsafeUrls(v, out);
}

/**
 * Reject a bundle whose Link/Image nodes carry a disallowed URL scheme
 * (`javascript:`, `data:`, …). The renderer sanitises these defensively too,
 * but a malicious or buggy bundle should never enter the store in the first
 * place. Walks the IR-bearing sections only (api / narrative / examples);
 * `assets` holds opaque bytes and is skipped.
 */
export function assertSafeUrls(bundle: BundleNode): void {
  const unsafe: string[] = [];
  collectUnsafeUrls(bundle.api, unsafe);
  collectUnsafeUrls(bundle.narrative, unsafe);
  collectUnsafeUrls(bundle.examples, unsafe);
  if (unsafe.length > 0) {
    const sample = unsafe.slice(0, 3).join(", ");
    throw new Error(
      `bundle contains ${unsafe.length} link/image URL(s) with a disallowed scheme ` +
        `(only http, https, mailto and relative URLs are allowed): ${sample}`,
    );
  }
}
