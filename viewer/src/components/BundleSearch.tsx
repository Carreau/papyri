import { useEffect, useRef, useState, type ReactElement } from "react";
import { linkForQualname } from "../lib/links.ts";
import { filterQualnames } from "../lib/search.ts";
import { qualnameLabel, qualnameParent } from "../lib/qualname.ts";

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
//
// The sidebar trigger opens a native <dialog> overlay with more room for
// results and a two-line layout (leaf name + dimmed module path).
// Arrow keys navigate through results; Enter follows the selected link.
export default function BundleSearch({ pkg, ver }: Props): ReactElement {
  const [qualnames, setQualnames] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/project/${pkg}/${ver}/search.json`);
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

  useEffect(() => {
    if (isOpen) {
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
      setQuery("");
    }
  }, [isOpen]);

  // Reset keyboard selection whenever the result list changes.
  useEffect(() => {
    setSelectedIndex(-1);
  }, [query]);

  // Keep the selected item scrolled into view.
  useEffect(() => {
    if (selectedIndex >= 0) {
      itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const hits = filterQualnames(qualnames, query, 100);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && selectedIndex >= 0 && hits[selectedIndex]) {
      window.location.href = linkForQualname(pkg, ver, hits[selectedIndex].qualname);
      setIsOpen(false);
    }
  };

  return (
    <>
      <button
        className="bundle-search-trigger"
        onClick={() => setIsOpen(true)}
        disabled={!ready}
        aria-label="Search API symbols"
        title="Search API symbols"
      >
        <span className="bundle-search-trigger-icon">⌕</span>
        <span className="bundle-search-trigger-text">
          {ready ? `Search ${qualnames.length} symbols…` : "Loading…"}
        </span>
      </button>
      {error ? <p className="bundle-search-error">Failed to load search index: {error}</p> : null}

      <dialog
        ref={dialogRef}
        className="bundle-search-dialog"
        onClose={() => setIsOpen(false)}
        onClick={(e) => {
          if (e.target === dialogRef.current) setIsOpen(false);
        }}
      >
        <div className="bundle-search-dialog-inner">
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Search ${qualnames.length} symbols in ${pkg}…`}
            className="bundle-search-dialog-input"
            aria-label="Search API symbols"
            aria-controls="bundle-search-results"
            aria-activedescendant={selectedIndex >= 0 ? `search-hit-${selectedIndex}` : undefined}
          />
          <ul id="bundle-search-results" className="bundle-search-dialog-results" role="listbox">
            {query.trim() === "" ? (
              <li className="bundle-search-empty">Type to search…</li>
            ) : hits.length === 0 ? (
              <li className="bundle-search-empty">No matches</li>
            ) : (
              hits.map((h, index) => {
                const label = qualnameLabel(h.qualname);
                const mod = qualnameParent(h.qualname);
                const isSelected = index === selectedIndex;
                return (
                  <li
                    key={h.qualname}
                    id={`search-hit-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                  >
                    <a
                      href={linkForQualname(pkg, ver, h.qualname)}
                      onClick={() => setIsOpen(false)}
                      tabIndex={-1}
                    >
                      <span className="search-hit-label">{label}</span>
                      <span className="search-hit-module">{mod ?? h.qualname}</span>
                    </a>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </dialog>
    </>
  );
}
