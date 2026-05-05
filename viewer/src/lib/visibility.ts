// Helpers for client-side visibility preferences.
//
// Two independent boolean flags are stored in localStorage and applied as
// data-attributes on <html> before first paint (via an inline script in
// Head.astro) to prevent flicker.
//
//   data-hide-types    → hide type annotations in function signatures
//   data-hide-private  → hide members/modules whose name starts with "_"
//
// The CSS in ir-nodes.css and global.css uses these attributes to toggle
// visibility without any runtime JS re-render.

export const HIDE_TYPES_KEY = "papyri-viewer:hide-types";
export const HIDE_PRIVATE_KEY = "papyri-viewer:hide-private";

export interface VisibilityPrefs {
  hideTypes: boolean;
  hidePrivate: boolean;
}

export function readPrefs(): VisibilityPrefs {
  try {
    return {
      hideTypes: localStorage.getItem(HIDE_TYPES_KEY) === "1",
      hidePrivate: localStorage.getItem(HIDE_PRIVATE_KEY) === "1",
    };
  } catch {
    return { hideTypes: false, hidePrivate: false };
  }
}

export function savePrefs(prefs: VisibilityPrefs): void {
  try {
    if (prefs.hideTypes) {
      localStorage.setItem(HIDE_TYPES_KEY, "1");
    } else {
      localStorage.removeItem(HIDE_TYPES_KEY);
    }
    if (prefs.hidePrivate) {
      localStorage.setItem(HIDE_PRIVATE_KEY, "1");
    } else {
      localStorage.removeItem(HIDE_PRIVATE_KEY);
    }
  } catch {
    // Private mode / storage disabled: toggles still work for the session.
  }
}

export interface VisibilityTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export function applyPrefs(target: VisibilityTarget, prefs: VisibilityPrefs): void {
  if (prefs.hideTypes) {
    target.setAttribute("data-hide-types", "");
  } else {
    target.removeAttribute("data-hide-types");
  }
  if (prefs.hidePrivate) {
    target.setAttribute("data-hide-private", "");
  } else {
    target.removeAttribute("data-hide-private");
  }
}
