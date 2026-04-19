import { describe, it, expect } from "vitest";
import {
  applyTheme,
  nextTheme,
  parseTheme,
  type ThemeTarget,
} from "../src/lib/theme.ts";

// Stub element that records calls. Not a full DOM — we're testing the
// pure applyTheme helper, not the island's React lifecycle.
function makeTarget(): ThemeTarget & {
  attrs: Record<string, string | null>;
} {
  const attrs: Record<string, string | null> = {};
  return {
    attrs,
    setAttribute(name: string, value: string) {
      attrs[name] = value;
    },
    removeAttribute(name: string) {
      attrs[name] = null;
    },
  };
}

describe("nextTheme", () => {
  it("flips dark<->light", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
  });
  it("treats null/undefined as light", () => {
    expect(nextTheme(null)).toBe("dark");
    expect(nextTheme(undefined)).toBe("dark");
  });
});

describe("parseTheme", () => {
  it("accepts 'dark'", () => {
    expect(parseTheme("dark")).toBe("dark");
  });
  it("falls back to light for everything else", () => {
    expect(parseTheme(null)).toBe("light");
    expect(parseTheme(undefined)).toBe("light");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("nonsense")).toBe("light");
  });
});

describe("applyTheme", () => {
  it("sets data-theme='dark' for dark", () => {
    const t = makeTarget();
    applyTheme(t, "dark");
    expect(t.attrs["data-theme"]).toBe("dark");
  });

  it("removes data-theme for light", () => {
    const t = makeTarget();
    t.attrs["data-theme"] = "dark"; // pretend the attribute was set
    applyTheme(t, "light");
    // removeAttribute was called — stub records null.
    expect(t.attrs["data-theme"]).toBeNull();
  });
});
