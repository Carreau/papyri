// Pure helpers for the dark-mode toggle island.
//
// The inline <script> in the shared head sets `data-theme` on <html> before
// first paint to avoid a flash of light content. The React island toggles
// the same attribute and persists the choice in localStorage. Both paths
// normalise through `nextTheme` / `applyTheme` so they can't disagree.

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "papyri-viewer:theme";

export function nextTheme(current: Theme | null | undefined): Theme {
  return current === "dark" ? "light" : "dark";
}

/**
 * Parse a value pulled from localStorage (or any other string source) and
 * return a valid Theme. Unknown values fall back to "light" so a corrupt
 * value can't leave the UI in a weird state.
 */
export function parseTheme(value: string | null | undefined): Theme {
  return value === "dark" ? "dark" : "light";
}

/**
 * Apply a theme to `root` (typically `document.documentElement`) by writing
 * the `data-theme` attribute. The helper is decoupled from the DOM so it
 * can be unit-tested with a plain `{ setAttribute, removeAttribute }` stub.
 */
export interface ThemeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export function applyTheme(target: ThemeTarget, theme: Theme): void {
  if (theme === "dark") {
    target.setAttribute("data-theme", "dark");
  } else {
    // Light is the default — keep the attribute empty so CSS `:root` rules
    // without the `[data-theme]` selector still apply cleanly.
    target.removeAttribute("data-theme");
  }
}
