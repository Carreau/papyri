// Client island: interactive full-text search within a single bundle.
//
// Sends a debounced request to /api/<pkg>/<ver>/text-search.json on each
// keystroke and renders up to 20 matching pages with a text snippet.

import { useEffect, useRef, useState } from "react";
import type { TextSearchResponse, TextHit } from "../pages/api/[pkg]/[ver]/text-search.json.ts";

interface Props {
  /** Bundle-scoped search when both set; cross-bundle when both omitted. */
  pkg?: string;
  ver?: string;
}

const DEBOUNCE_MS = 300;

export default function TextSearchPanel({ pkg, ver }: Props) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<TextSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apiPath = pkg && ver ? `/api/${pkg}/${ver}/text-search.json` : `/api/text-search.json`;
  const placeholder =
    pkg && ver ? `Search text in ${pkg} ${ver}…` : "Search text across all bundles…";

  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    if (query.trim() === "") {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    timerRef.current = setTimeout(() => {
      const u = new URL(apiPath, window.location.origin);
      u.searchParams.set("q", query);
      fetch(u.toString())
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<TextSearchResponse>;
        })
        .then((data) => {
          setResult(data);
          setError(null);
        })
        .catch((e: unknown) => setError(String(e)))
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [apiPath, query]);

  const hits: TextHit[] = result?.hits ?? [];

  return (
    <div className="text-search">
      <input
        type="search"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search documentation text"
        className="bundle-search-input"
      />

      {loading && <p className="nodes-loading">Searching…</p>}
      {error && <p className="nodes-error">Search failed: {error}</p>}

      {!loading && result !== null && (
        <>
          <p className="lede">
            {hits.length === 0
              ? `No results for "${result.query}"`
              : hits.length >= 20
                ? `First 20 results for "${result.query}"`
                : `${hits.length} result${hits.length !== 1 ? "s" : ""} for "${result.query}"`}
          </p>

          {hits.length > 0 && (
            <ol className="text-search-results">
              {hits.map((hit, i) => (
                <li key={i} className="text-search-hit">
                  <a href={hit.href} className="text-search-hit-label">
                    {hit.label}
                  </a>
                  <p className="text-search-hit-snippet">{hit.snippet}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
