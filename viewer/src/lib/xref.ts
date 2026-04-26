// Shared CrossRef resolution logic used by all three content page types
// (qualname, doc, example). Closes over the cached SQLite handle from
// graph.ts so the DB is opened once and queried on demand per node.
//
// The CrossRef IR shape:
//   { __type: "CrossRef", value: label, reference: RefInfo, kind, anchor }
// where `reference` is a RefInfo tag node with fields
// (module, version, kind, path). We resolve via that, falling back to null
// for the papyri sentinel "current-module" / "to-resolve" placeholders.
import { resolveRef } from "./graph.ts";
import { linkForRef } from "./links.ts";

export interface XRefShape {
  value?: string;
  reference?: {
    module?: string;
    version?: string;
    kind?: string;
    path?: string;
  } | null;
  kind?: string;
}

export function resolveXref(raw: unknown): { url: string; label: string } | null {
  const n = raw as XRefShape | null;
  if (!n) return null;
  const label = n.value ?? "";
  const ref = n.reference;
  if (!ref || !ref.module || !ref.path || !ref.kind) return null;
  if (ref.module === "current-module" || ref.kind === "to-resolve") return null;
  const resolved = resolveRef({
    pkg: ref.module,
    ver: ref.version ?? "?",
    kind: ref.kind,
    path: ref.path,
  });
  if (!resolved) return null;
  const url = linkForRef(resolved);
  if (!url) return null;
  return { url, label };
}
