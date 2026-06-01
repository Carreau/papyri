/**
 * IR tree walker for the ingest step.
 *
 * collectForwardRefs() mirrors Python's IngestedDoc.all_forward_refs():
 * it walks a decoded IR tree and returns every RefInfo node (excluding
 * kind="local") and every Figure node, expressed as Key tuples suitable
 * for the graph store.
 */

import type { IRNode, TypedNode } from "./encoder.js";
import { keyStr, type Key } from "./keys.js";

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

/** Shared helper: walk `subtree` and collect RefInfo/Figure keys into `keys`. */
function collectRefsFromSubtree(subtree: AnyValue, keys: Map<string, Key>): void {
  const nodes = collectNodes(subtree, FORWARD_REF_TYPES);
  for (const n of nodes) {
    if (n.__type === "RefInfo") {
      const kind = n.kind as string | null;
      if (kind === "local") continue;
      const key: Key = {
        module: (n.module as string) ?? "",
        version: (n.version as string) ?? "?",
        kind: kind ?? "module",
        path: (n.path as string) ?? "",
      };
      keys.set(keyStr(key), key);
    } else if (n.__type === "Figure") {
      // Figure.value is a RefInfo-shaped node pointing at an asset.
      const ref = n.value as TypedNode | null;
      if (!ref || ref.__type !== "RefInfo") continue;
      if ((ref.kind as string) !== "assets") continue;
      const key: Key = {
        module: (ref.module as string) ?? "",
        version: (ref.version as string) ?? "?",
        kind: "assets",
        path: (ref.path as string) ?? "",
      };
      keys.set(keyStr(key), key);
    }
  }
}

function sortKeys(keys: Map<string, Key>): Key[] {
  return [...keys.values()].sort((a, b) => {
    const sa = keyStr(a);
    const sb = keyStr(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

/**
 * Extract all forward-reference Keys from a decoded IngestedDoc.
 * Mirrors Python's IngestedDoc.all_forward_refs().
 *
 * - RefInfo nodes with kind != "local" are included as-is.
 * - Figure nodes whose embedded RefInfo has kind == "assets" are included.
 */
export function collectForwardRefs(doc: IRNode): Key[] {
  const d = doc as TypedNode;
  const subtrees: AnyValue[] = [];
  if (d._content && typeof d._content === "object") {
    subtrees.push(...Object.values(d._content as Record<string, AnyValue>));
  }
  if (d.example_section_data) subtrees.push(d.example_section_data);
  if (Array.isArray(d.arbitrary)) subtrees.push(...d.arbitrary);
  if (Array.isArray(d.see_also)) subtrees.push(...d.see_also);

  const keys = new Map<string, Key>();
  collectRefsFromSubtree(subtrees, keys);
  return sortKeys(keys);
}

/**
 * Extract forward refs from a bare Section blob (used for examples/).
 * Accepts any IR subtree; handles RefInfo and Figure nodes.
 */
export function collectForwardRefsFromSection(section: IRNode): Key[] {
  const keys = new Map<string, Key>();
  collectRefsFromSubtree(section, keys);
  return sortKeys(keys);
}
