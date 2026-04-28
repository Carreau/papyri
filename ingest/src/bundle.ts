/**
 * Explode a decoded `Bundle` Node into the per-file directory layout the
 * existing `Ingester` consumes.
 *
 * `papyri pack` writes a `.papyri` artifact = gzip(canonical-CBOR(Bundle)).
 * The viewer's upload endpoint gunzips + cbor-decodes the request body to a
 * Bundle TypedNode, then calls into here to materialise the bundle as the
 * `~/.papyri/data/<pkg>_<ver>/`-shaped directory tree the Ingester already
 * understands. That keeps the ingest pipeline format-agnostic: pack/upload
 * is the contract, the Ingester's input format is unchanged.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { encode, type TypedNode } from "./encoder.js";

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

function asRecord<T>(value: unknown): Record<string, T> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, T>;
  }
  return {};
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

/**
 * Write a decoded Bundle out to *destDir* as a gen-bundle directory tree.
 *
 * Layout produced — matches what `papyri gen` writes to disk:
 *   papyri.json           {module, version, summary?, github_slug?, tag?,
 *                           logo?, aliases?, ...extra}
 *   module/<qa>.cbor      encoded GeneratedDoc
 *   docs/<key>            encoded GeneratedDoc (no .cbor suffix, matches gen)
 *   examples/<key>        encoded Section
 *   assets/<filename>     raw asset bytes
 *   toc.cbor              encoded list[TocTree]   (only when non-empty)
 *
 * Empty optional sections are skipped — the Ingester's existsSync checks
 * tolerate that.
 */
export async function explodeBundleToDir(node: unknown, destDir: string): Promise<void> {
  assertBundle(node);
  const bundle = node;

  await mkdir(destDir, { recursive: true });

  // papyri.json — known string fields plus any forward-compatible extras.
  const meta: Record<string, unknown> = {
    module: bundle.module,
    version: bundle.version,
  };
  if (bundle.summary) meta["summary"] = bundle.summary;
  if (bundle.github_slug) meta["github_slug"] = bundle.github_slug;
  if (bundle.tag) meta["tag"] = bundle.tag;
  if (bundle.logo) meta["logo"] = bundle.logo;
  const aliases = asRecord<string>(bundle.aliases);
  if (Object.keys(aliases).length > 0) meta["aliases"] = aliases;
  for (const [k, v] of Object.entries(asRecord<unknown>(bundle.extra))) {
    if (!(k in meta)) meta[k] = v;
  }
  await writeFile(join(destDir, "papyri.json"), JSON.stringify(meta, null, 2));

  // API — module/<qualname>.cbor
  const api = asRecord<TypedNode>(bundle.api);
  if (Object.keys(api).length > 0) {
    const moduleDir = join(destDir, "module");
    await mkdir(moduleDir, { recursive: true });
    for (const [qa, doc] of Object.entries(api)) {
      await writeFile(join(moduleDir, `${qa}.cbor`), encode(doc));
    }
  }

  // Narrative — docs/<key>  (no extension; matches what `papyri gen` writes)
  const narrative = asRecord<TypedNode>(bundle.narrative);
  if (Object.keys(narrative).length > 0) {
    const docsDir = join(destDir, "docs");
    await mkdir(docsDir, { recursive: true });
    for (const [key, doc] of Object.entries(narrative)) {
      await writeFile(join(docsDir, key), encode(doc));
    }
  }

  // Examples — examples/<key>  (encoded Section)
  const examples = asRecord<TypedNode>(bundle.examples);
  if (Object.keys(examples).length > 0) {
    const examplesDir = join(destDir, "examples");
    await mkdir(examplesDir, { recursive: true });
    for (const [key, section] of Object.entries(examples)) {
      await writeFile(join(examplesDir, key), encode(section));
    }
  }

  // Assets — assets/<filename> (raw bytes)
  const assets = asRecord<Uint8Array | Buffer>(bundle.assets);
  if (Object.keys(assets).length > 0) {
    const assetsDir = join(destDir, "assets");
    await mkdir(assetsDir, { recursive: true });
    for (const [name, bytes] of Object.entries(assets)) {
      await writeFile(join(assetsDir, name), bytes);
    }
  }

  // TOC — toc.cbor  (only when non-empty; matches gen.write_narrative)
  if (Array.isArray(bundle.toc) && bundle.toc.length > 0) {
    await writeFile(join(destDir, "toc.cbor"), encode(bundle.toc));
  }
}
