// Client island: a cog button in the header that opens a dropdown gathering
// every client-side display preference (all backed by localStorage):
//   - theme (light / dark)
//   - hide type annotations
//   - hide private members
//   - inline member docs
//
// Each pref is read back from whatever the inline head script already applied,
// so the menu hydrates without a flash. The theme lives in theme.ts; the three
// visibility flags live in visibility.ts — this component is just the shared UI.

import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  HIDE_TYPES_KEY,
  HIDE_PRIVATE_KEY,
  INLINE_MEMBERS_KEY,
  applyPrefs,
  savePrefs,
  type VisibilityPrefs,
} from "../lib/visibility.ts";
import { THEME_STORAGE_KEY, applyTheme, parseTheme, type Theme } from "../lib/theme.ts";

export default function SettingsMenu(): ReactElement {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("light");
  const [prefs, setPrefs] = useState<VisibilityPrefs>({
    hideTypes: false,
    hidePrivate: false,
    inlineMembers: false,
  });
  const ref = useRef<HTMLDivElement>(null);

  // Hydrate from whatever the inline head script already applied / localStorage.
  useEffect(() => {
    const currentTheme =
      document.documentElement.getAttribute("data-theme") === "dark"
        ? "dark"
        : parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
    setTheme(currentTheme);
    setPrefs({
      hideTypes: localStorage.getItem(HIDE_TYPES_KEY) === "1",
      hidePrivate: localStorage.getItem(HIDE_PRIVATE_KEY) === "1",
      inlineMembers: localStorage.getItem(INLINE_MEMBERS_KEY) === "1",
    });
  }, []);

  // Close on outside click or Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function setDark(dark: boolean): void {
    const next: Theme = dark ? "dark" : "light";
    setTheme(next);
    applyTheme(document.documentElement, next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private mode / disabled storage: toggle still works for the session.
    }
  }

  function updatePrefs(next: VisibilityPrefs): void {
    setPrefs(next);
    savePrefs(next);
    applyPrefs(document.documentElement, next);
  }

  return (
    <div className="settings-menu" ref={ref}>
      <button
        type="button"
        className="settings-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Display settings"
        title="Display settings"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{"⚙"}</span>
      </button>

      {open && (
        <div className="settings-menu-dropdown" role="menu" aria-label="Display settings">
          <label className="settings-menu-item" title="Switch between light and dark themes">
            <input
              type="checkbox"
              checked={theme === "dark"}
              onChange={(e) => setDark(e.target.checked)}
            />
            <span>dark mode</span>
          </label>
          <label className="settings-menu-item" title="Hide type annotations in signatures">
            <input
              type="checkbox"
              checked={prefs.hideTypes}
              onChange={(e) => updatePrefs({ ...prefs, hideTypes: e.target.checked })}
            />
            <span>hide types</span>
          </label>
          <label
            className="settings-menu-item"
            title="Hide private members (names starting with _)"
          >
            <input
              type="checkbox"
              checked={prefs.hidePrivate}
              onChange={(e) => updatePrefs({ ...prefs, hidePrivate: e.target.checked })}
            />
            <span>hide private</span>
          </label>
          <label className="settings-menu-item" title="Expand member docs inline on qualname pages">
            <input
              type="checkbox"
              checked={prefs.inlineMembers}
              onChange={(e) => updatePrefs({ ...prefs, inlineMembers: e.target.checked })}
            />
            <span>inline members</span>
          </label>
        </div>
      )}
    </div>
  );
}
