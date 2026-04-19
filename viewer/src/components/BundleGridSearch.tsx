// Client island: filters the landing page bundle cards by (pkg, summary)
// substring match. The cards are rendered server-side by Astro; this island
// reads them via data-attributes and toggles the `hidden` attribute.
//
// Usage in index.astro:
//   <BundleGridSearch client:load bundles={arr} gridId="bundle-card-grid" />
//
// Each card must have:
//   data-pkg="{pkg}"
//   data-summary="{summary}"
// on the <a class="bundle-card"> element.

import { useEffect, useRef } from "react";

interface BundleEntry {
  pkg: string;
  summary: string;
}

interface Props {
  bundles: BundleEntry[];
  gridId: string;
}

export default function BundleGridSearch({ bundles: _bundles, gridId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    function onInput() {
      const q = input!.value.trim().toLowerCase();
      const grid = document.getElementById(gridId);
      if (!grid) return;
      const cards = grid.querySelectorAll<HTMLElement>(".bundle-card");
      for (const card of cards) {
        if (!q) {
          card.hidden = false;
          continue;
        }
        const pkg = (card.dataset.pkg ?? "").toLowerCase();
        const summary = (card.dataset.summary ?? "").toLowerCase();
        card.hidden = !pkg.includes(q) && !summary.includes(q);
      }
    }

    input.addEventListener("input", onInput);
    return () => input.removeEventListener("input", onInput);
  }, [gridId]);

  return (
    <div className="bundle-grid-search">
      <input
        ref={inputRef}
        type="search"
        className="bundle-search-input"
        placeholder="Filter packages…"
        aria-label="Filter packages"
      />
    </div>
  );
}
