import { describe, it, expect } from "vitest";
import { highlight } from "../src/lib/highlight.ts";

describe("highlight", () => {
  it("produces Shiki-colored HTML for python by default", async () => {
    const html = await highlight("print(1)");
    // Shiki decorates tokens with inline color styles.
    expect(html).toMatch(/style="color:/);
  });

  it("falls back to python for unknown language", async () => {
    const html = await highlight("x = 1", "not-a-real-lang");
    expect(html).toMatch(/style="color:/);
  });
}, 30_000);
