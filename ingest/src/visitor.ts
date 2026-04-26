/**
 * IR tree walker for the ingest step.
 *
 * collectForwardRefs() mirrors Python's IngestedDoc.all_forward_refs():
 * it walks a decoded IR tree and returns every RefInfo node (excluding
 * kind="local") and every Figure node, expressed as Key tuples suitable
 * for the GraphStore.
 */

import type { IRNode, TypedNode } from "./encoder.js";
import type { Key } from "./graphstore.js";

type AnyValue = unknown;

/** Walk a decoded IR tree and collect every node whose __type is in `types`. */
function collectNodes(
  val: AnyValue,
  types: ReadonlySet<string>,
  out: TypedNode[] = [],
): TypedNode[] {
  if (!val || typeof val !== "object") return out;
  if (Array.isArray(val)) {
    for (const item of val) collectNodes(item, types, out);
    return out;
  }
  const node = val as Record<string, AnyValue>;
  if (typeof node.__type === "string" && types.has(node.__type)) {
    out.push(node as TypedNode);
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") collectNodes(v, types, out);
  }
  return out;
}

const FORWARD_REF_TYPES = new Set(["RefInfo", "Figure"]);

/**
 * Extract all forward-reference Keys from a decoded IngestedDoc (or any
 * decoded IR subtree).  Mirrors Python's IngestedDoc.all_forward_refs().
 *
 * - RefInfo nodes with kind != "local" are included as-is.
 * - Figure nodes whose embedded RefInfo has kind == "assets" are included.
 */
export function collectForwardRefs(doc: IRNode): Key[] {
  // Walk the same sub-trees as Python: _content values, example_section_data,
  // arbitrary, see_also.
  const d = doc as TypedNode;

  const subtrees: AnyValue[] = [];
  if (d._content && typeof d._content === "object") {
    subtrees.push(...Object.values(d._content as Record<string, AnyValue>));
  }
  if (d.example_section_data) subtrees.push(d.example_section_data);
  if (Array.isArray(d.arbitrary)) subtrees.push(...d.arbitrary);
  if (Array.isArray(d.see_also)) subtrees.push(...d.see_also);

  const nodes = collectNodes(subtrees, FORWARD_REF_TYPES);

  const keys = new Map<string, Key>();

  for (const n of nodes) {
    if (n.__type === "RefInfo") {
      let kind = n.kind as string | null;
      if (kind === "local") continue;
      // Gen-time cross-package unresolved stubs have kind="api", version="*".
      // Normalise to kind="module", version="?" so the stored link target
      // matches the actual on-disk node (which uses kind="module").
      if (kind === "api") kind = "module";
      const rawVersion = (n.version as string) ?? "?";
      const version = rawVersion === "*" ? "?" : rawVersion;
      const key: Key = {
        module: (n.module as string) ?? "",
        version,
        kind: kind ?? "module",
        path: (n.path as string) ?? "",
      };
      keys.set(`${key.module}/${key.version}/${key.kind}/${key.path}`, key);
    } else if (n.__type === "Figure") {
      // Figure.value is a RefInfo-shaped node.
      const ref = n.value as TypedNode | null;
      if (!ref || ref.__type !== "RefInfo") continue;
      if ((ref.kind as string) !== "assets") continue;
      const key: Key = {
        module: (ref.module as string) ?? "",
        version: (ref.version as string) ?? "?",
        kind: "assets",
        path: (ref.path as string) ?? "",
      };
      keys.set(`${key.module}/${key.version}/${key.kind}/${key.path}`, key);
    }
  }

  return [...keys.values()].sort((a, b) => {
    const sa = `${a.module}/${a.version}/${a.kind}/${a.path}`;
    const sb = `${b.module}/${b.version}/${b.kind}/${b.path}`;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

/**
 * Extract forward refs from a bare Section blob (used for examples/).
 * Identical to collectForwardRefs but accepts any IR subtree.
 */
export function collectForwardRefsFromSection(section: IRNode): Key[] {
  const nodes = collectNodes(section, FORWARD_REF_TYPES);
  const keys = new Map<string, Key>();

  for (const n of nodes) {
    if (n.__type === "RefInfo") {
      let kind = n.kind as string | null;
      if (kind === "local") continue;
      if (kind === "api") kind = "module";
      const rawVersion = (n.version as string) ?? "?";
      const version = rawVersion === "*" ? "?" : rawVersion;
      const key: Key = {
        module: (n.module as string) ?? "",
        version,
        kind: kind ?? "module",
        path: (n.path as string) ?? "",
      };
      keys.set(`${key.module}/${key.version}/${key.kind}/${key.path}`, key);
    }
  }

  return [...keys.values()].sort((a, b) => {
    const sa = `${a.module}/${a.version}/${a.kind}/${a.path}`;
    const sb = `${b.module}/${b.version}/${b.kind}/${b.path}`;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}
