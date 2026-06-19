/**
 * IR tree walker for the ingest step.
 *
 * Walks a decoded IR subtree and returns every RefInfo node (excluding
 * kind="local") and every asset-bearing Figure node, expressed as Key
 * tuples suitable for the graph store. Both public entry points
 * (collectForwardRefs / collectForwardRefsFromSection) share the same
 * walker and key-collection path; they differ only in which subtrees of
 * their input they feed to it.
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

/**
 * The single collect-and-sort path: walk `subtree` for RefInfo/Figure
 * nodes and return their deduplicated Keys in lexicographic order.
 *
 * - RefInfo nodes with kind != "local" are included as-is.
 * - Figure nodes whose embedded RefInfo has kind == "assets" are included.
 */
function forwardRefKeys(subtree: AnyValue): Key[] {
  const keys = new Map<string, Key>();
  collectRefsFromSubtree(subtree, keys);
  return [...keys.values()].sort((a, b) => {
    const sa = keyStr(a);
    const sb = keyStr(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

/**
 * Extract all forward-reference Keys from a decoded IngestedDoc.
 *
 * Only the section-bearing fields are walked. The doc's other fields
 * (signature, references, aliases, qa, …) hold strings/primitives, never
 * RefInfo/Figure nodes, so excluding them keeps signature type strings out
 * of the forward-ref graph even if they later become structured.
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
  return forwardRefKeys(subtrees);
}

/**
 * Extract forward refs from a bare Section blob (used for examples/).
 * Accepts any IR subtree; handles RefInfo and Figure nodes.
 */
export function collectForwardRefsFromSection(section: IRNode): Key[] {
  return forwardRefKeys(section);
}
