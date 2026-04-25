/**
 * CBOR codec for the papyri IR.
 *
 * Decoding mirrors viewer/src/lib/ir-reader.ts but adds:
 *  - local_refs field for IngestedDoc (tag 4010) and GeneratedDoc (tag 4011)
 *  - encode() to re-serialise a decoded IR tree back to CBOR bytes
 *  - generatedDocToIngested() to convert tag-4011 → tag-4010
 *
 * Field ordering must exactly match Python's get_type_hints(cls) on each Node
 * subclass (declaration order in the class body), because Node.cbor() uses
 * that ordering for the positional CBOR array.
 */

import { Decoder, Encoder, Tag, addExtension } from "cbor-x";

// ---------------------------------------------------------------------------
// TypedNode shapes (same as viewer, re-exported for consumers)
// ---------------------------------------------------------------------------

export interface TypedNode {
  __type: string;
  __tag: number;
  [k: string]: unknown;
}

export interface UnknownNode {
  __type: "unknown";
  __tag: number;
  value: unknown;
}

export type IRNode = TypedNode | UnknownNode;

// ---------------------------------------------------------------------------
// FIELD_ORDER — positional field lists per CBOR tag.
//
// Must exactly match Python's typing.get_type_hints(cls) order.
// Source of truth: papyri/crosslink.py (IngestedDoc), papyri/gen.py
// (GeneratedDoc), papyri/nodes.py (everything else).
//
// Compared to viewer/src/lib/ir-reader.ts, this table adds:
//   - local_refs (index 12) on IngestedDoc (4010)
//   - local_refs (index 11) on GeneratedDoc (4011)
// ---------------------------------------------------------------------------

export const FIELD_ORDER: Readonly<Record<number, { name: string; fields: readonly string[] }>> = {
  4000: { name: "RefInfo", fields: ["module", "version", "kind", "path"] },
  4001: { name: "Root", fields: ["children"] },
  4002: { name: "CrossRef", fields: ["value", "reference", "kind", "anchor"] },
  4003: { name: "InlineRole", fields: ["value", "domain", "role", "inventory"] },
  4010: {
    name: "IngestedDoc",
    fields: [
      "_content",
      "_ordered_sections",
      "item_file",
      "item_line",
      "item_type",
      "aliases",
      "example_section_data",
      "see_also",
      "signature",
      "references",
      "qa",
      "arbitrary",
      "local_refs",
    ],
  },
  4011: {
    name: "GeneratedDoc",
    fields: [
      "_content",
      "example_section_data",
      "_ordered_sections",
      "item_file",
      "item_line",
      "item_type",
      "aliases",
      "see_also",
      "signature",
      "references",
      "arbitrary",
      "local_refs",
    ],
  },
  4012: { name: "NumpydocExample", fields: ["value"] },
  4013: { name: "NumpydocSeeAlso", fields: ["value"] },
  4014: { name: "NumpydocSignature", fields: ["value"] },
  4015: { name: "Section", fields: ["children", "title", "level", "target"] },
  4016: { name: "DocParam", fields: ["name", "annotation", "desc"] },
  4017: { name: "UnimplementedInline", fields: ["children"] },
  4018: { name: "Unimplemented", fields: ["placeholder", "value"] },
  4019: { name: "ThematicBreak", fields: [] },
  4020: { name: "Heading", fields: ["depth", "children"] },
  4021: { name: "TocTree", fields: ["children", "title", "ref", "open", "current"] },
  4022: { name: "LocalRef", fields: ["kind", "path"] },
  4024: { name: "Figure", fields: ["value"] },
  4026: { name: "Parameters", fields: ["children"] },
  4027: { name: "SubstitutionDef", fields: ["value", "children"] },
  4028: { name: "SeeAlsoItem", fields: ["name", "descriptions", "type"] },
  4029: {
    name: "SignatureNode",
    fields: ["kind", "parameters", "return_annotation", "target_name"],
  },
  4030: { name: "SigParam", fields: ["name", "annotation", "kind", "default"] },
  4031: { name: "Empty", fields: [] },
  4033: { name: "DefList", fields: ["children"] },
  4034: { name: "Options", fields: ["values"] },
  4035: { name: "FieldList", fields: ["children"] },
  4036: { name: "FieldListItem", fields: ["name", "body"] },
  4037: { name: "DefListItem", fields: ["dt", "dd"] },
  4041: { name: "SubstitutionRef", fields: ["value"] },
  4045: { name: "Paragraph", fields: ["children"] },
  4046: { name: "Text", fields: ["value"] },
  4047: { name: "Emphasis", fields: ["children"] },
  4048: { name: "Strong", fields: ["children"] },
  4049: { name: "Link", fields: ["children", "url", "title"] },
  4050: { name: "Code", fields: ["value", "execution_status"] },
  4051: { name: "InlineCode", fields: ["value"] },
  4052: { name: "Directive", fields: ["name", "args", "options", "value", "children"] },
  4053: { name: "BulletList", fields: ["ordered", "start", "spread", "children"] },
  4054: { name: "ListItem", fields: ["spread", "children"] },
  4055: { name: "AdmonitionTitle", fields: ["children"] },
  4056: { name: "Admonition", fields: ["children", "kind"] },
  4057: { name: "InlineMath", fields: ["value"] },
  4058: { name: "Math", fields: ["value"] },
  4059: { name: "Blockquote", fields: ["children"] },
  4060: { name: "Comment", fields: ["value"] },
  4061: { name: "Target", fields: ["label"] },
  4062: { name: "Image", fields: ["url", "alt"] },
  4063: { name: "CitationReference", fields: ["label"] },
  4064: { name: "Citation", fields: ["label", "children"] },
} as const;

const TUPLE_TAG = 4444;

function buildTyped(tag: number, value: unknown): IRNode {
  if (tag === TUPLE_TAG) {
    return { __type: "tuple", __tag: tag, value } as TypedNode;
  }
  const spec = FIELD_ORDER[tag];
  if (!spec) {
    return { __type: "unknown", __tag: tag, value };
  }
  if (!Array.isArray(value)) {
    return { __type: "unknown", __tag: tag, value };
  }
  const node: TypedNode = { __type: spec.name, __tag: tag };
  spec.fields.forEach((fname, i) => {
    node[fname] = value[i];
  });
  return node;
}

let _extensionsRegistered = false;
function ensureExtensions(): void {
  if (_extensionsRegistered) return;
  _extensionsRegistered = true;

  addExtension({
    Class: Object as unknown as new (...a: unknown[]) => object,
    tag: TUPLE_TAG,
    encode() {
      throw new Error("encode not implemented for tuple tag");
    },
    decode(item: unknown) {
      return item;
    },
  });

  for (const tagStr of Object.keys(FIELD_ORDER)) {
    const tag = Number(tagStr);
    addExtension({
      Class: Object as unknown as new (...a: unknown[]) => object,
      tag,
      encode() {
        throw new Error("use toEncodable() before encoding IR nodes");
      },
      decode(item: unknown) {
        return buildTyped(tag, item);
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/** Decode a CBOR buffer into a decoded IR tree of TypedNode objects. */
export function decode<T = unknown>(buf: Buffer | Uint8Array): T {
  ensureExtensions();
  const dec = new Decoder({ mapsAsObjects: true });
  return dec.decode(buf) as T;
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Walk a decoded IR tree and convert every TypedNode back to a Tag(tag, [...])
 * that cbor-x can serialise. Plain objects (CBOR maps like _content) are
 * recursively processed but remain as plain objects.
 */
export function toEncodable(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val !== "object") return val;
  if (val instanceof Uint8Array) return val;
  if (Array.isArray(val)) return val.map(toEncodable);

  const node = val as Record<string, unknown>;

  if (typeof node.__type === "string" && typeof node.__tag === "number") {
    const tag = node.__tag;
    if (tag === TUPLE_TAG) {
      // Decoded tuples become plain arrays; re-encode as CBOR arrays (lists).
      return Array.isArray(node.value) ? node.value.map(toEncodable) : [];
    }
    const spec = FIELD_ORDER[tag];
    if (spec) {
      const values = spec.fields.map((f) => toEncodable(node[f] ?? null));
      return new Tag(values, tag);
    }
    // Unknown node — preserve the raw value best-effort.
    return toEncodable(node.value);
  }

  // Plain object (CBOR map): recursively process values, strip __ meta keys.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k !== "__type" && k !== "__tag") {
      out[k] = toEncodable(v);
    }
  }
  return out;
}

const _encoder = new Encoder();

/** Encode a decoded IR tree (or any CBOR-compatible value) to bytes. */
export function encode(val: unknown): Uint8Array {
  return _encoder.encode(toEncodable(val));
}

// ---------------------------------------------------------------------------
// GeneratedDoc → IngestedDoc conversion
// ---------------------------------------------------------------------------

/**
 * Convert a decoded GeneratedDoc node (tag 4011) into an IngestedDoc node
 * (tag 4010), adding the `qa` qualifier and re-ordering fields to match the
 * IngestedDoc type-hint declaration order.
 *
 * Field mapping (GeneratedDoc index → IngestedDoc field):
 *   0  _content              → _content
 *   1  example_section_data  → example_section_data
 *   2  _ordered_sections     → _ordered_sections
 *   3  item_file             → item_file
 *   4  item_line             → item_line
 *   5  item_type             → item_type
 *   6  aliases               → aliases
 *   7  see_also              → see_also
 *   8  signature             → signature
 *   9  references            → references
 *   10 arbitrary             → arbitrary
 *   11 local_refs            → local_refs
 *   (new)                   → qa (from filename)
 */
export function generatedDocToIngested(genDoc: TypedNode, qa: string): TypedNode {
  if (genDoc.__type !== "GeneratedDoc") {
    throw new Error(`expected GeneratedDoc, got ${genDoc.__type}`);
  }
  return {
    __type: "IngestedDoc",
    __tag: 4010,
    _content: genDoc._content ?? {},
    _ordered_sections: genDoc._ordered_sections ?? [],
    item_file: genDoc.item_file ?? null,
    item_line: genDoc.item_line ?? null,
    item_type: genDoc.item_type ?? null,
    aliases: genDoc.aliases ?? [],
    example_section_data: genDoc.example_section_data ?? null,
    see_also: genDoc.see_also ?? [],
    signature: genDoc.signature ?? null,
    references: genDoc.references ?? null,
    qa,
    arbitrary: genDoc.arbitrary ?? [],
    local_refs: (genDoc.local_refs as string[] | undefined) ?? [],
  };
}
