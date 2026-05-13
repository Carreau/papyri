import { useEffect, useRef, useState, type ReactElement } from "react";
import { linkForQualname } from "../lib/links.ts";
import { filterQualnames, type SearchHit } from "../lib/search.ts";
import { getRecentSearches, addRecentSearch, clearRecentSearches } from "../lib/recent-searches.ts";

interface Props {
  pkg: string;
  ver: string;
}

// Client-side search island scoped to a single bundle.
//
// On mount, fetches `/<pkg>/<ver>/search.json` (the manifest emitted by
// `src/pages/[pkg]/[ver]/search.json.ts`), then filters client-side on each
// keystroke. Shows recent searches when the input is focused but empty.
export default function BundleSearch({ pkg, ver }: Props): ReactElement {
  const [qualnames, setQualnames] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/${pkg}/${ver}/search.json`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { qualnames: string[] };
        if (cancelled) return;
        setQualnames(data.qualnames ?? []);
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pkg, ver]);

  // Dismiss the recent-searches panel on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const hits: SearchHit[] = filterQualnames(qualnames, query, 50);
  const trimmed = query.trim();
  const showRecents = focused && trimmed === "" && recents.length > 0;
  const showResults = trimmed !== "";

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

  function handleResultClick() {
    if (trimmed) addRecentSearch(trimmed);
  }

  return (
    <div className="bundle-search" ref={containerRef}>
      <input
        type="search"
        placeholder={
          ready ? `Search ${qualnames.length} qualnames in ${pkg}` : "Loading search index..."
        }
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={handleFocus}
        aria-label="Search qualnames"
        disabled={!ready}
        className="bundle-search-input"
      />
      {error ? <p className="bundle-search-error">Failed to load search index: {error}</p> : null}

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

      {showResults && (
        <ul className="bundle-search-results">
          {hits.length === 0 ? (
            <li className="bundle-search-empty">No matches</li>
          ) : (
            hits.map((h) => (
              <li key={h.qualname}>
                <a href={linkForQualname(pkg, ver, h.qualname)} onClick={handleResultClick}>
                  {h.qualname}
                </a>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
