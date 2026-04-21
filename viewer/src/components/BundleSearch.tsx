import { useEffect, useState, type ReactElement } from "react";
import { filterQualnames, type SearchHit } from "../lib/search.ts";

interface Props {
  pkg: string;
  ver: string;
}

// Client-side search island scoped to a single bundle.
//
// On mount, fetches `/<pkg>/<ver>/search.json` (the manifest emitted by
// `src/pages/[pkg]/[ver]/search.json.ts`), then filters client-side on each
// keystroke. The filter helper is pulled out to `lib/search.ts` so it can
// be unit-tested without hydrating React.
export default function BundleSearch({ pkg, ver }: Props): ReactElement {
  const [qualnames, setQualnames] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const hits: SearchHit[] = filterQualnames(qualnames, query, 50);

  // Slug mirrors ir-reader#qualnameToSlug. We reimplement the trivial `:`→`$`
  // swap here rather than importing a Node-specific module into the client
  // bundle.
  const slug = (qa: string): string => qa.replace(/:/g, "$");

  return (
    <div className="bundle-search">
      <input
        type="search"
        placeholder={
          ready ? `Search ${qualnames.length} qualnames in ${pkg}` : "Loading search index..."
        }
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search qualnames"
        disabled={!ready}
        className="bundle-search-input"
      />
      {error ? <p className="bundle-search-error">Failed to load search index: {error}</p> : null}
      {query.trim() !== "" ? (
        <ul className="bundle-search-results">
          {hits.length === 0 ? (
            <li className="bundle-search-empty">No matches</li>
          ) : (
            hits.map((h) => (
              <li key={h.qualname}>
                <a href={`/${pkg}/${ver}/${slug(h.qualname)}/`}>{h.qualname}</a>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
