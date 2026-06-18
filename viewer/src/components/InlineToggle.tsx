// Client island: toggles inline member/function expansion via URL query params
// and localStorage preference. Placed in the members section header.
//
// Usage on class pages:
//   <InlineToggle client:load toggleType="members" />
// Usage on module pages:
//   <InlineToggle client:load toggleType="functions" />
//
// The toggle:
//   1. Reads URL ?inline-members=1 or ?inline-functions=1
//   2. Falls back to localStorage key (papyri-viewer:inline-members or papyri-viewer:inline-functions)
//   3. Updates URL query param when clicked (triggers CSS via data-inline-members attribute)
//   4. Persists choice to localStorage for cross-page memory

import { useEffect, useState, type ReactElement } from "react";
import { applyPrefs, readPrefs, savePrefs } from "../lib/visibility.ts";

export interface Props {
  toggleType: "members" | "functions";
}

export default function InlineToggle({ toggleType }: Props): ReactElement {
  const [isInlined, setIsInlined] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    // Determine initial state from URL or localStorage.
    // URL param takes precedence.
    const urlParams = new URLSearchParams(window.location.search);
    const urlKey = toggleType === "members" ? "inline-members" : "inline-functions";
    const urlValue = urlParams.get(urlKey);

    let state = false;
    if (urlValue === "1") {
      state = true;
    } else if (urlValue === "0") {
      state = false;
    } else {
      // Fall back to localStorage
      const prefs = readPrefs();
      state = prefs.inlineMembers;
    }

    setIsInlined(state);
    // Apply the state to the document
    applyPrefs(document.documentElement, {
      ...readPrefs(),
      inlineMembers: state,
    });
    setHasHydrated(true);
  }, [toggleType]);

  function handleToggle(): void {
    const newState = !isInlined;
    setIsInlined(newState);

    // Update URL query param without full page reload
    const url = new URL(window.location.href);
    const urlKey = toggleType === "members" ? "inline-members" : "inline-functions";
    if (newState) {
      url.searchParams.set(urlKey, "1");
    } else {
      url.searchParams.delete(urlKey);
    }
    window.history.replaceState(null, "", url);

    // Update localStorage
    const prefs = readPrefs();
    const newPrefs = { ...prefs, inlineMembers: newState };
    savePrefs(newPrefs);

    // Apply to document
    applyPrefs(document.documentElement, newPrefs);
  }

  if (!hasHydrated) return <div />;

  const title =
    toggleType === "members"
      ? "Show full docstrings and signatures for all class members inline"
      : "Show full docstrings and signatures for all module functions inline";

  return (
    <button
      type="button"
      className={`inline-toggle ${isInlined ? "inline-toggle-active" : ""}`}
      title={title}
      onClick={handleToggle}
      aria-pressed={isInlined}
    >
      {isInlined ? "↓ Collapse all" : "→ Expand all"}
    </button>
  );
}
