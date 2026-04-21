import { useEffect, useState, type ReactElement } from "react";
import { THEME_STORAGE_KEY, applyTheme, nextTheme, parseTheme, type Theme } from "../lib/theme.ts";

// Tiny React island: reads the theme already applied by the inline head
// script, flips it on click, writes it back to localStorage.
//
// The inline script in Layout.astro has already set document.documentElement
// before this component mounts, so we hydrate to whatever it picked and
// avoid a flash. No external state library.
export default function ThemeToggle(): ReactElement {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    // Prefer the attribute already set by the synchronous head script, fall
    // back to localStorage, then default to light.
    const current =
      document.documentElement.getAttribute("data-theme") === "dark"
        ? "dark"
        : parseTheme(
            typeof localStorage !== "undefined" ? localStorage.getItem(THEME_STORAGE_KEY) : null
          );
    setTheme(current);
  }, []);

  const onClick = (): void => {
    const next = nextTheme(theme);
    setTheme(next);
    applyTheme(document.documentElement, next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private mode / disabled storage: toggle still works for the session.
    }
  };

  const label = theme === "dark" ? "Light mode" : "Dark mode";
  const icon = theme === "dark" ? "\u263C" : "\u263E"; // sun / crescent moon

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}
