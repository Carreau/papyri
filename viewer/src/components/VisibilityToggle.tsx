// Client island: checkboxes that toggle type-annotation, private-member, and
// inline-members visibility. State persists in localStorage and is reflected
// as data-attributes on <html>, which CSS selectors use to hide/show the
// relevant elements.

import { useEffect, useState, type ReactElement } from "react";
import {
  HIDE_TYPES_KEY,
  HIDE_PRIVATE_KEY,
  INLINE_MEMBERS_KEY,
  applyPrefs,
  savePrefs,
  type VisibilityPrefs,
} from "../lib/visibility.ts";

export default function VisibilityToggle(): ReactElement {
  const [prefs, setPrefs] = useState<VisibilityPrefs>({
    hideTypes: false,
    hidePrivate: false,
    inlineMembers: false,
  });

  useEffect(() => {
    // Hydrate from whatever the inline head script already applied.
    setPrefs({
      hideTypes: localStorage.getItem(HIDE_TYPES_KEY) === "1",
      hidePrivate: localStorage.getItem(HIDE_PRIVATE_KEY) === "1",
      inlineMembers: localStorage.getItem(INLINE_MEMBERS_KEY) === "1",
    });
  }, []);

  function update(next: VisibilityPrefs): void {
    setPrefs(next);
    savePrefs(next);
    applyPrefs(document.documentElement, next);
  }

  return (
    <div className="visibility-toggles" role="group" aria-label="Display options">
      <label className="visibility-label" title="Hide type annotations in signatures">
        <input
          type="checkbox"
          checked={prefs.hideTypes}
          onChange={(e) => update({ ...prefs, hideTypes: e.target.checked })}
        />
        <span>hide types</span>
      </label>
      <label className="visibility-label" title="Hide private members (names starting with _)">
        <input
          type="checkbox"
          checked={prefs.hidePrivate}
          onChange={(e) => update({ ...prefs, hidePrivate: e.target.checked })}
        />
        <span>hide private</span>
      </label>
      <label className="visibility-label" title="Expand member and function docs inline">
        <input
          type="checkbox"
          checked={prefs.inlineMembers}
          onChange={(e) => update({ ...prefs, inlineMembers: e.target.checked })}
        />
        <span>inline members</span>
      </label>
    </div>
  );
}
