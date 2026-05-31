// Helpers for client-side visibility preferences.
//
// Three independent boolean flags are stored in localStorage and applied as
// data-attributes on <html> before first paint (via an inline script in
// Head.astro) to prevent flicker.
//
//   data-hide-types      → hide type annotations in function signatures
//   data-hide-private    → hide members/modules whose name starts with "_"
//   data-inline-members  → expand member/function docs inline on class/module pages
//
// The CSS in ir-nodes.css and global.css uses these attributes to toggle
// visibility without any runtime JS re-render.

export const HIDE_TYPES_KEY = "papyri-viewer:hide-types";
export const HIDE_PRIVATE_KEY = "papyri-viewer:hide-private";
export const INLINE_MEMBERS_KEY = "papyri-viewer:inline-members";

export interface VisibilityPrefs {
  hideTypes: boolean;
  hidePrivate: boolean;
  inlineMembers: boolean;
}

export function readPrefs(): VisibilityPrefs {
  try {
    return {
      hideTypes: localStorage.getItem(HIDE_TYPES_KEY) === "1",
      hidePrivate: localStorage.getItem(HIDE_PRIVATE_KEY) === "1",
      inlineMembers: localStorage.getItem(INLINE_MEMBERS_KEY) === "1",
    };
  } catch {
    return { hideTypes: false, hidePrivate: false, inlineMembers: false };
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
    if (prefs.inlineMembers) {
      localStorage.setItem(INLINE_MEMBERS_KEY, "1");
    } else {
      localStorage.removeItem(INLINE_MEMBERS_KEY);
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
  if (prefs.inlineMembers) {
    target.setAttribute("data-inline-members", "");
  } else {
    target.removeAttribute("data-inline-members");
  }
}
