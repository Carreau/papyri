// Client island: interactive full-text search within a single bundle.
//
// Sends a debounced request to /api/<pkg>/<ver>/text-search.json on each
// keystroke and renders up to 20 matching pages with a text snippet.
// Shows recent searches when the input is focused but empty.

import { useEffect, useRef, useState } from "react";
import type { TextSearchResponse, TextHit } from "../pages/api/[pkg]/[ver]/text-search.json.ts";
import { getRecentSearches, addRecentSearch, clearRecentSearches } from "../lib/recent-searches.ts";

interface Props {
  pkg: string;
  ver: string;
}

const DEBOUNCE_MS = 300;

export default function TextSearchPanel({ pkg, ver }: Props) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<TextSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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
      const u = new URL(`/api/${pkg}/${ver}/text-search.json`, window.location.origin);
      u.searchParams.set("q", query);
      fetch(u.toString())
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<TextSearchResponse>;
        })
        .then((data) => {
          setResult(data);
          setError(null);
          addRecentSearch(query.trim());
        })
        .catch((e: unknown) => setError(String(e)))
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [pkg, ver, query]);

  // Dismiss recent-searches panel on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const hits: TextHit[] = result?.hits ?? [];
  const trimmed = query.trim();
  const showRecents = focused && trimmed === "" && recents.length > 0;

  function handleFocus() {
    setRecents(getRecentSearches());
    setFocused(true);
  }

  function applyRecent(q: string) {
    setQuery(q);
    setFocused(false);
  }

  function handleClearRecents(e: React.MouseEvent) {
    e.preventDefault();
    clearRecentSearches();
    setRecents([]);
  }

  return (
    <div className="text-search" ref={containerRef}>
      <input
        type="search"
        placeholder={`Search text in ${pkg} ${ver}…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={handleFocus}
        aria-label="Search documentation text"
        className="bundle-search-input"
      />

      {showRecents && (
        <div className="recent-searches">
          <div className="recent-searches-header">
            <span>Recent</span>
            <button className="recent-searches-clear" onClick={handleClearRecents}>
              Clear
            </button>
          </div>
          <ul className="bundle-search-results">
            {recents.map((r) => (
              <li key={r}>
                <button className="recent-searches-item" onClick={() => applyRecent(r)}>
                  {r}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

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
