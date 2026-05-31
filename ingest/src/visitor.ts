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

/**
 * Turn a flat list of collected forward-ref nodes into a deduped, sorted Key
 * list.  `collectNodes(_, FORWARD_REF_TYPES)` only yields nodes whose `__type`
 * is in FORWARD_REF_TYPES, so this loop must have a branch for every member of
 * that set.  The final `else` is a completeness guard: a type added to
 * FORWARD_REF_TYPES without a matching branch here would otherwise be collected
 * and then silently dropped, losing every graph edge it should contribute (the
 * bug class behind the missing-Figure-branch drift). Failing loud beats
 * silently dropping edges.
 */
function refsFromNodes(nodes: TypedNode[]): Key[] {
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
      keys.set(keyStr(key), key);
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
      keys.set(keyStr(key), key);
    } else {
      throw new Error(
        `collectForwardRefs: no handler for forward-ref type ${n.__type} — ` +
          "it is in FORWARD_REF_TYPES but refsFromNodes would drop it.",
      );
    }
  }

  return [...keys.values()].sort((a, b) => {
    const sa = keyStr(a);
    const sb = keyStr(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

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

  return refsFromNodes(collectNodes(subtrees, FORWARD_REF_TYPES));
}

/**
 * Extract forward refs from a bare Section blob (used for examples/).
 * Identical to collectForwardRefs but walks the whole section subtree.
 */
export function collectForwardRefsFromSection(section: IRNode): Key[] {
  return refsFromNodes(collectNodes(section, FORWARD_REF_TYPES));
}
