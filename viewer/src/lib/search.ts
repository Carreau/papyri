// Pure helpers for the client-side search island.
//
// Scope is deliberately tiny: case-insensitive substring match over a flat
// list of qualname strings, bounded to `limit` hits. No ranking, no fuzzy,
// no IR content. The manifest the island fetches is emitted by
// `src/pages/[pkg]/[ver]/search.json.ts` at build time.

export interface SearchHit {
  /** The qualname as stored in the IR, e.g. "numpy.linalg:svd". */
  qualname: string;
}

/**
 * Filter `qualnames` to those that contain `query` (case-insensitive).
 * Returns up to `limit` hits in their original order. An empty / whitespace
 * query returns an empty array so the island can collapse cleanly.
 */
export function filterQualnames(
  qualnames: readonly string[],
  query: string,
  limit = 50,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const out: SearchHit[] = [];
  for (const qa of qualnames) {
    if (qa.toLowerCase().includes(q)) {
      out.push({ qualname: qa });
      if (out.length >= limit) break;
    }
  }
  return out;
}
