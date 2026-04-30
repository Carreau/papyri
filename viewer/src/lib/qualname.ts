// Qualname parsing helpers.
//
// Qualnames in papyri use two separators:
//   `.`  between modules                 (e.g. `papyri.directives`)
//   `:`  between a module and an object  (e.g. `papyri.directives:warning_handler`)
//   `.`  after `:` between an object and its members
//        (e.g. `papyri.tree:DirectiveVisiter.add_target`)
//
// There is at most one `:` in a qualname.

export function qualnameParent(qa: string): string | null {
  const colonIdx = qa.indexOf(":");
  if (colonIdx >= 0) {
    const lastDot = qa.lastIndexOf(".");
    if (lastDot > colonIdx) return qa.slice(0, lastDot);
    return qa.slice(0, colonIdx);
  }
  const lastDot = qa.lastIndexOf(".");
  if (lastDot >= 0) return qa.slice(0, lastDot);
  return null;
}

export function qualnameLabel(qa: string): string {
  const colonIdx = qa.indexOf(":");
  const lastDot = qa.lastIndexOf(".");
  let sep = -1;
  if (colonIdx >= 0 && lastDot > colonIdx) sep = lastDot;
  else if (colonIdx >= 0) sep = colonIdx;
  else sep = lastDot;
  return sep >= 0 ? qa.slice(sep + 1) : qa;
}

export function qualnameDepth(qa: string): number {
  let d = 1;
  for (let i = 0; i < qa.length; i++) {
    const ch = qa.charCodeAt(i);
    // '.' = 46, ':' = 58
    if (ch === 46 || ch === 58) d++;
  }
  return d;
}

/** Ancestors of `qa` from root to `qa` itself (inclusive). */
export function qualnameAncestors(qa: string): string[] {
  const out: string[] = [];
  let cur: string | null = qa;
  while (cur) {
    out.unshift(cur);
    cur = qualnameParent(cur);
  }
  return out;
}
