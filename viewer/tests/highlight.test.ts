import { describe, it, expect } from "vitest";
import { highlight } from "../src/lib/highlight.ts";

describe("highlight", () => {
  it("produces dual-theme Shiki HTML for python by default", async () => {
    const html = await highlight("print(1)");
    // Dual-theme mode emits CSS variable pairs instead of literal colors.
    expect(html).toMatch(/--shiki-light:/);
    expect(html).toMatch(/--shiki-dark:/);
  });

  it("falls back to python for unknown language", async () => {
    const html = await highlight("x = 1", "not-a-real-lang");
    expect(html).toMatch(/--shiki-light:/);
    expect(html).toMatch(/--shiki-dark:/);
  });
}, 30_000);
